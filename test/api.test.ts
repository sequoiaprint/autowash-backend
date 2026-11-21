import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sleep, waitFor, type Harness } from './support/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const logs = (harness: Harness) => harness.prisma.configChangeLog.findMany({ orderBy: { createdAt: 'asc' } });

describe('GET /machine/state', () => {
  it('returns connection, status, config and updatedAt', async () => {
    h = await createHarness();
    const res = await h.api('GET', '/machine/state');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      brokerConnected: true,
      machineOnline: true,
      status: { state: 'idle', wash: 0 },
      config: { washes: expect.any(Array), timing: expect.any(Object) },
      updatedAt: expect.any(String),
    });
  });

  it('reports an offline machine', async () => {
    h = await createHarness();
    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'offline');
    const res = await h.api('GET', '/machine/state');
    expect(res.body.data).toMatchObject({ brokerConnected: true, machineOnline: false });
  });

  it('has null status and config before the machine has ever been seen', async () => {
    h = await createHarness({ espOnline: false });
    await waitFor(() => h!.runtime.machine.getSnapshot().brokerConnected, 3000, 'broker');
    const res = await h.api('GET', '/machine/state');
    expect(res.body.data).toMatchObject({ machineOnline: false, status: null, config: null });
  });
});

describe('saving a sequence', () => {
  const steps = [{ t: 'uv', m: 2 }, { t: 'break' }, { t: 'process', m: 7 }];

  it('merges into the latest config, sends the full payload and returns after the ack', async () => {
    h = await createHarness();
    const before = structuredClone(h.esp.config);
    const res = await h.api('PUT', '/wash-config/sequences/3', { steps });
    expect(res.status).toBe(200);

    const sent = h.esp.received.find((m) => m.topic === 'config/set')!.body;
    expect(sent.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    const washes = sent.washes as unknown[][];
    expect(washes).toHaveLength(4);
    expect(washes[2]).toEqual(steps);
    expect(washes[0]).toEqual(before.washes[0]);
    expect(washes[1]).toEqual(before.washes[1]);
    expect(washes[3]).toEqual(before.washes[3]);
    expect(sent.timing).toEqual(before.timing); // every timing is sent too

    expect(h.esp.config.washes[2]).toEqual(steps);
    expect((res.body.data as { config: { washes: unknown[] } }).config.washes[2]).toEqual(steps);
  });

  it('merges into the latest config even if it was changed on the machine meanwhile', async () => {
    h = await createHarness();
    h.esp.config.timing.air.sec = 55;
    h.esp.publishConfigNow();
    await waitFor(() => h!.runtime.machine.getConfig()?.timing.air.sec === 55, 2000, 'config cache');
    await h.api('PUT', '/wash-config/sequences/1', { steps });
    const sent = h.esp.received.filter((m) => m.topic === 'config/set').at(-1)!.body;
    expect((sent.timing as { air: { sec: number } }).air.sec).toBe(55);
  });

  it('logs the change as APPLIED with the previous and requested config', async () => {
    h = await createHarness();
    const before = structuredClone(h.esp.config);
    await h.api('PUT', '/wash-config/sequences/2', { steps });
    const [entry, ...rest] = await logs(h);
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ changeType: 'SEQUENCE', washNumber: 2, result: 'APPLIED', errorCode: null });
    expect(entry!.requestId).toBe(h.esp.received[0]!.body.id);
    expect(entry!.previousConfig).toEqual(before);
    expect((entry!.requestedConfig as { washes: unknown[] }).washes[1]).toEqual(steps);
  });

  it.each([
    ['wash number 0', '/wash-config/sequences/0', { steps }],
    ['wash number 5', '/wash-config/sequences/5', { steps }],
    ['wash number abc', '/wash-config/sequences/abc', { steps }],
    ['no steps', '/wash-config/sequences/1', { steps: [] }],
    ['25 steps', '/wash-config/sequences/1', { steps: Array(25).fill({ t: 'water', m: 1 }) }],
    ['m = 0', '/wash-config/sequences/1', { steps: [{ t: 'water', m: 0 }] }],
    ['m = 100', '/wash-config/sequences/1', { steps: [{ t: 'water', m: 100 }] }],
    ['air step', '/wash-config/sequences/1', { steps: [{ t: 'air', m: 1 }] }],
    ['clean step', '/wash-config/sequences/1', { steps: [{ t: 'clean', m: 1 }] }],
    ['m on break', '/wash-config/sequences/1', { steps: [{ t: 'break', m: 1 }] }],
    ['missing m', '/wash-config/sequences/1', { steps: [{ t: 'water' }] }],
    ['extra field', '/wash-config/sequences/1', { steps: [{ t: 'water', m: 1 }], extra: true }],
    ['no body', '/wash-config/sequences/1', {}],
  ])('rejects %s with 400 and sends nothing', async (_name, path, body) => {
    h = await createHarness();
    const res = await h.api('PUT', path, body);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(h.esp.received.filter((m) => m.topic === 'config/set')).toHaveLength(0);
  });

  it('accepts exactly 24 steps with m=99', async () => {
    h = await createHarness();
    const res = await h.api('PUT', '/wash-config/sequences/1', { steps: Array(24).fill({ t: 'water', m: 99 }) });
    expect(res.status).toBe(200);
  });

  it('returns 409 and sends nothing while a wash is active', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
    const res = await h.api('PUT', '/wash-config/sequences/2', { steps });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('MACHINE_BUSY');
    expect(h.esp.received.filter((m) => m.topic === 'config/set')).toHaveLength(0);
  });

  it('returns 503 when the current config is not known yet', async () => {
    h = await createHarness({ espOnline: false });
    h.esp.withholdConfig = true;
    await h.esp.start();
    await waitFor(() => h!.runtime.machine.isReady(), 3000, 'machine online');
    await sleep(100);
    expect(h.runtime.machine.getConfig()).toBeNull();
    const res = await h.api('PUT', '/wash-config/sequences/1', { steps });
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('CONFIG_UNKNOWN');
    expect(h.esp.received.filter((m) => m.topic === 'config/set')).toHaveLength(0);
  });
});

describe('saving timing', () => {
  it('saves the timing and keeps all washes', async () => {
    h = await createHarness();
    const before = structuredClone(h.esp.config);
    const timing = { ...before.timing, process: { releaseMs: 250, waitS: 45 }, air: { sec: 60 } };
    const res = await h.api('PUT', '/wash-config/timing', { timing });
    expect(res.status).toBe(200);
    expect(h.esp.config.timing).toEqual(timing);
    expect(h.esp.config.washes).toEqual(before.washes);
    const [entry] = await logs(h);
    expect(entry).toMatchObject({ changeType: 'TIMING', washNumber: null, result: 'APPLIED' });
  });

  it.each([
    ['releaseMs 9', ['process', 'releaseMs'], 9],
    ['releaseMs 5001', ['water', 'releaseMs'], 5001],
    ['waitS 0', ['uv', 'waitS'], 0],
    ['waitS 601', ['uv', 'waitS'], 601],
    ['durMin 0', ['clean', 'durMin'], 0],
    ['durMin 31', ['clean', 'durMin'], 31],
    ['air 4', ['air', 'sec'], 4],
    ['air 121', ['air', 'sec'], 121],
    ['fractional', ['process', 'waitS'], 1.5],
  ])('rejects %s', async (_name, path, value) => {
    h = await createHarness();
    const timing = structuredClone(h.esp.config.timing) as unknown as Record<string, Record<string, number>>;
    timing[path[0]!]![path[1]!] = value;
    const res = await h.api('PUT', '/wash-config/timing', { timing });
    expect(res.status).toBe(400);
    expect(h.esp.received.filter((m) => m.topic === 'config/set')).toHaveLength(0);
  });

  it('rejects a timing with a missing group', async () => {
    h = await createHarness();
    const { air: _air, ...timing } = h.esp.config.timing;
    expect((await h.api('PUT', '/wash-config/timing', { timing })).status).toBe(400);
  });
});

describe('config change log', () => {
  it('logs failed saves too, with the error code', async () => {
    h = await createHarness();
    h.esp.failNextWith = 'invalid';
    expect((await h.api('PUT', '/wash-config/sequences/1', { steps: [{ t: 'water', m: 1 }] })).status).toBe(422);
    h.esp.failNextWith = 'storage';
    expect((await h.api('PUT', '/wash-config/timing', { timing: h.esp.config.timing })).status).toBe(500);
    const entries = await logs(h);
    expect(entries.map((e) => [e.changeType, e.result, e.errorCode])).toEqual([
      ['SEQUENCE', 'REJECTED', 'MACHINE_REJECTED'],
      ['TIMING', 'REJECTED', 'MACHINE_STORAGE_ERROR'],
    ]);
    expect(entries.every((e) => e.requestId)).toBe(true);
  });

  it('logs a timed out save as TIMED_OUT', async () => {
    h = await createHarness({ ackTimeoutMs: 200 });
    h.esp.silent = true;
    await h.api('PUT', '/wash-config/timing', { timing: h.esp.config.timing });
    const [entry] = await logs(h);
    expect(entry).toMatchObject({ result: 'TIMED_OUT', errorCode: 'MACHINE_TIMEOUT' });
  });

  it('logs a save refused because a wash is active', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
    await h.api('PUT', '/wash-config/timing', { timing: h.esp.config.timing });
    const [entry] = await logs(h);
    expect(entry).toMatchObject({ result: 'REJECTED', errorCode: 'MACHINE_BUSY', requestId: null });
  });

  it('logs a save refused because the machine is offline', async () => {
    h = await createHarness();
    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'offline');
    await h.api('PUT', '/wash-config/timing', { timing: h.esp.config.timing });
    const [entry] = await logs(h);
    expect(entry).toMatchObject({ result: 'REJECTED', errorCode: 'MACHINE_OFFLINE' });
  });

  it('does not log the first config seen after startup', async () => {
    h = await createHarness();
    await sleep(150);
    expect(await logs(h)).toHaveLength(0);
  });

  it('does not log the same config published again', async () => {
    h = await createHarness();
    h.esp.publishConfigNow();
    h.esp.publishConfigNow();
    await sleep(150);
    expect(await logs(h)).toHaveLength(0);
  });

  it('logs a change made on the machine as EXTERNAL / DETECTED', async () => {
    h = await createHarness();
    const before = structuredClone(h.esp.config);
    h.esp.config.washes[1] = [{ t: 'uv', m: 9 }];
    h.esp.publishConfigNow();
    await waitFor(async () => (await logs(h!)).length === 1, 3000, 'external log');
    const [entry] = await logs(h);
    expect(entry).toMatchObject({ changeType: 'EXTERNAL', result: 'DETECTED', washNumber: 2, requestId: null });
    expect(entry!.previousConfig).toEqual(before);
    expect((entry!.requestedConfig as { washes: unknown[] }).washes[1]).toEqual([{ t: 'uv', m: 9 }]);
  });

  it('does not log an API save as EXTERNAL as well', async () => {
    h = await createHarness();
    await h.api('PUT', '/wash-config/sequences/1', { steps: [{ t: 'water', m: 3 }] });
    await sleep(150);
    const entries = await logs(h);
    expect(entries.map((e) => e.changeType)).toEqual(['SEQUENCE']);
  });

  it('lists history newest first with pagination', async () => {
    h = await createHarness();
    for (const air of [10, 15, 20]) {
      await h.api('PUT', '/wash-config/timing', { timing: { ...h.esp.config.timing, air: { sec: air } } });
    }
    const page1 = await h.api('GET', '/wash-config/history?page=1&limit=2');
    const data = page1.body.data as { items: { requestedConfig: { timing: { air: { sec: number } } } }[]; total: number; page: number; limit: number };
    expect(data).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(data.items.map((i) => i.requestedConfig.timing.air.sec)).toEqual([20, 15]);
    const page2 = await h.api('GET', '/wash-config/history?page=2&limit=2');
    expect((page2.body.data as { items: unknown[] }).items).toHaveLength(1);
    expect((await h.api('GET', '/wash-config/history?limit=0')).status).toBe(400);
    expect((await h.api('GET', '/wash-config/history?limit=101')).status).toBe(400);
  });
});

describe('request validation for control', () => {
  it('rejects a bad wash number and sends nothing', async () => {
    h = await createHarness();
    for (const body of [{ wash: 0 }, { wash: 5 }, { wash: '1' }, {}, { wash: 1, x: 1 }]) {
      const res = await h.api('POST', '/wash-control/start', body);
      expect(res.status).toBe(400);
    }
    expect(h.esp.received).toHaveLength(0);
  });

  it('answers malformed JSON in the standard error format', async () => {
    h = await createHarness();
    const res = await fetch(`${h.baseUrl}/api/v1/wash-control/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: { code: 'BAD_REQUEST', message: expect.any(String) } });
  });
});
