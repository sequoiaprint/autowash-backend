import { afterEach, describe, expect, it } from 'vitest';
import { createMqttClient } from '../src/infrastructure/mqtt/index.js';
import { TestBroker } from './support/broker.js';
import { createHarness, sleep, waitFor, type Harness } from './support/harness.js';

const CMD = 'autowash/ryobi2/cmd';
const SET = 'autowash/ryobi2/config/set';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const sequenceBody = { steps: [{ t: 'process', m: 2 }, { t: 'break' }, { t: 'water', m: 1 }] };

describe('ack success', () => {
  it('sends a valid command and returns once the ESP acks', async () => {
    h = await createHarness();
    const res = await h.api('POST', '/wash-control/start', { wash: 1 });
    expect(res).toMatchObject({ status: 200, body: { success: true, data: { action: 'start', wash: 1 } } });
    expect(h.esp.received).toHaveLength(1);
    const sent = h.esp.received[0]!;
    expect(sent.topic).toBe('cmd');
    expect(sent.body).toMatchObject({ action: 'start', wash: 1 });
    expect(sent.body.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('publishes commands and saves at QoS 1 without retain, and only to cmd and config/set', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 2 });
    await h.api('POST', '/wash-control/stop');
    const published = h.broker.published.filter((m) => m.clientId === 'autowash_backend_test');
    expect(published.length).toBeGreaterThan(0);
    for (const m of published) {
      expect([CMD, SET]).toContain(m.topic);
      expect(m.retain).toBe(false);
      expect(m.topic.startsWith('relay/')).toBe(false);
    }
  });

  it('uses a different request id each time', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await h.api('POST', '/wash-control/pause');
    await h.api('POST', '/wash-control/resume');
    const ids = h.esp.received.map((m) => m.body.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('every ack error', () => {
  const commandCases: [string, number, string][] = [
    ['busy', 409, 'MACHINE_BUSY'],
    ['not_running', 409, 'INVALID_MACHINE_STATE'],
    ['not_paused', 409, 'INVALID_MACHINE_STATE'],
    ['invalid', 422, 'MACHINE_REJECTED'],
    ['bad_command', 422, 'MACHINE_REJECTED'],
    ['storage', 500, 'MACHINE_STORAGE_ERROR'],
  ];

  it.each(commandCases)('command ack error %s becomes %s %s', async (error, httpStatus, code) => {
    h = await createHarness();
    h.esp.failNextWith = error as never;
    const res = await h.api('POST', '/wash-control/start', { wash: 1 });
    expect(res.status).toBe(httpStatus);
    expect(res.body).toEqual({ success: false, error: { code, message: expect.any(String) } });
  });

  it.each(commandCases)('config ack error %s becomes %s %s', async (error, httpStatus, code) => {
    h = await createHarness();
    h.esp.failNextWith = error as never;
    const res = await h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    expect(res.status).toBe(httpStatus);
    expect(res.body.error?.code).toBe(code);
  });

  it('real firmware errors: pause when nothing runs, resume when not paused, stop when idle', async () => {
    h = await createHarness();
    expect((await h.api('POST', '/wash-control/pause')).body.error?.code).toBe('INVALID_MACHINE_STATE');
    expect((await h.api('POST', '/wash-control/resume')).body.error?.code).toBe('INVALID_MACHINE_STATE');
    expect((await h.api('POST', '/wash-control/stop')).body.error?.code).toBe('INVALID_MACHINE_STATE');
  });

  it('real firmware error: a second start while running is busy', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    expect((await h.api('POST', '/wash-control/start', { wash: 2 })).body.error?.code).toBe('MACHINE_BUSY');
  });
});

describe('timeout', () => {
  it('returns 504 MACHINE_TIMEOUT when no ack arrives, and does not retry', async () => {
    h = await createHarness({ ackTimeoutMs: 300 });
    h.esp.silent = true;
    const started = Date.now();
    const res = await h.api('POST', '/wash-control/start', { wash: 1 });
    expect(res.status).toBe(504);
    expect(res.body.error?.code).toBe('MACHINE_TIMEOUT');
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    await sleep(600); // a retry would show up here
    expect(h.esp.received).toHaveLength(1);
  });

  it('ignores an ack that arrives after the timeout', async () => {
    h = await createHarness({ ackTimeoutMs: 200 });
    h.esp.silent = true;
    const res = await h.api('PUT', '/wash-config/timing', { timing: { ...h.esp.config.timing, air: { sec: 25 } } });
    expect(res.status).toBe(504);
    // the pending save is cleared, so a new one is allowed
    h.esp.silent = false;
    const next = await h.api('PUT', '/wash-config/timing', { timing: { ...h.esp.config.timing, air: { sec: 30 } } });
    expect(next.status).toBe(200);
  });
});

describe('offline rejection', () => {
  it('rejects at once with 503 MACHINE_OFFLINE when the machine is offline, and sends nothing', async () => {
    h = await createHarness();
    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'machine offline');
    const before = h.broker.on(CMD).length + h.broker.on(SET).length;
    const started = Date.now();
    const start = await h.api('POST', '/wash-control/start', { wash: 1 });
    const stop = await h.api('POST', '/wash-control/stop');
    const save = await h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    expect(Date.now() - started).toBeLessThan(500);
    for (const res of [start, stop, save]) {
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe('MACHINE_OFFLINE');
    }
    expect(h.broker.on(CMD).length + h.broker.on(SET).length).toBe(before);
  });

  it('rejects when the broker is down', async () => {
    h = await createHarness();
    await h.broker.stop();
    await waitFor(() => !h!.runtime.machine.getSnapshot().brokerConnected, 3000, 'broker down');
    const res = await h.api('POST', '/wash-control/start', { wash: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MACHINE_OFFLINE');
  });

  it('does not send while the machine state is unknown (nothing seen from the machine yet)', async () => {
    h = await createHarness({ espOnline: false });
    await waitFor(() => h!.runtime.machine.getSnapshot().brokerConnected, 3000, 'broker connected');
    const res = await h.api('POST', '/wash-control/start', { wash: 1 });
    expect(res.status).toBe(503);
    expect(h.broker.on(CMD)).toHaveLength(0);
  });
});

describe('no replay after reconnect', () => {
  it('a client with the production options drops a publish made while disconnected', async () => {
    const broker = await TestBroker.start();
    try {
      const client = createMqttClient({ url: broker.url, clientId: 'replay_probe', reconnectPeriodMs: 400 });
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
      broker.dropClient('replay_probe');
      await waitFor(() => !client.connected, 2000, 'client disconnected');
      client.publish(CMD, JSON.stringify({ id: 'late', action: 'start', wash: 1 }), { qos: 1, retain: false }, () => undefined);
      client.publish(SET, JSON.stringify({ id: 'late2' }), { qos: 1, retain: false }, () => undefined);
      await new Promise<void>((resolve) => client.once('connect', () => resolve())); // reconnected
      await sleep(400);
      expect(broker.on(CMD)).toHaveLength(0);
      expect(broker.on(SET)).toHaveLength(0);
      await client.endAsync(true);
    } finally {
      await broker.stop();
    }
  });

  it('a command in flight when the connection drops is not sent again after reconnecting', async () => {
    h = await createHarness({ ackTimeoutMs: 3000 });
    h.esp.silent = true; // the request stays pending
    const pending = h.api('POST', '/wash-control/start', { wash: 1 });
    await waitFor(() => h!.broker.on(CMD).length === 1, 2000, 'command published');
    h.broker.dropClient('autowash_backend_test');
    const res = await pending;
    expect(res.status).toBe(503); // outcome unknown, reported at once
    expect(res.body.error?.code).toBe('MACHINE_OFFLINE');

    await waitFor(() => h!.runtime.machine.isReady(), 5000, 'reconnected and ready');
    await sleep(500);
    expect(h.broker.on(CMD)).toHaveLength(1); // still exactly one message ever published
    expect(h.esp.received).toHaveLength(1);
  });

  it('a save in flight when the connection drops is not sent again after reconnecting', async () => {
    h = await createHarness({ ackTimeoutMs: 3000 });
    h.esp.silent = true;
    const pending = h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    await waitFor(() => h!.broker.on(SET).length === 1, 2000, 'save published');
    h.broker.dropClient('autowash_backend_test');
    expect((await pending).status).toBe(503);
    await waitFor(() => h!.runtime.machine.isReady(), 5000, 'ready again');
    await sleep(500);
    expect(h.broker.on(SET)).toHaveLength(1);
  });
});

describe('request ordering', () => {
  it('only one config save is in flight at a time', async () => {
    h = await createHarness({ ackTimeoutMs: 1500 });
    h.esp.silent = 'config';
    const first = h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    await waitFor(() => h!.broker.on(SET).length === 1, 2000, 'first save published');
    const second = await h.api('PUT', '/wash-config/sequences/2', sequenceBody);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('MACHINE_BUSY');
    expect(h.broker.on(SET)).toHaveLength(1); // the second was never sent or queued
    expect((await first).status).toBe(504);
  });

  it('a stop never waits behind a pending config save', async () => {
    h = await createHarness({ ackTimeoutMs: 2000 });
    h.esp.silent = 'config';
    const save = h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    await waitFor(() => h!.broker.on(SET).length === 1, 2000, 'save published');

    const started = Date.now();
    expect((await h.api('POST', '/wash-control/start', { wash: 1 })).status).toBe(200);
    expect((await h.api('POST', '/wash-control/stop')).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.esp.engine.state).toBe('stopped');
    expect((await save).status).toBe(504); // the save was still pending the whole time
  });

  it('a stop is never blocked or rejected by a pending start, pause, resume or config save', async () => {
    h = await createHarness({ ackTimeoutMs: 3000 });
    h.esp.mutedActions = ['start', 'pause', 'resume'];
    h.esp.silent = 'config';

    const save = h.api('PUT', '/wash-config/sequences/1', sequenceBody);
    await waitFor(() => h!.broker.on(SET).length === 1, 2000, 'save published');
    const start = h.api('POST', '/wash-control/start', { wash: 1 });
    await waitFor(() => h!.broker.on(CMD).length === 1, 2000, 'start published');
    const pause = h.api('POST', '/wash-control/pause');
    await waitFor(() => h!.broker.on(CMD).length === 2, 2000, 'pause published');
    const resume = h.api('POST', '/wash-control/resume');
    await waitFor(() => h!.broker.on(CMD).length === 3, 2000, 'resume published');

    // four requests are now waiting for an ack. The stop must go out at once and be answered.
    const started = Date.now();
    const stop = await h.api('POST', '/wash-control/stop');
    expect(stop.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.broker.on(CMD)).toHaveLength(4);
    expect(h.esp.engine.state).toBe('stopped');

    // none of the others had been answered when the stop completed
    const results = await Promise.all([start, pause, resume, save]);
    expect(results.map((r) => r.status)).toEqual([504, 504, 504, 504]);
    expect(Date.now() - started).toBeGreaterThan(2000);
  });

  it('a second stop while a stop is pending is also sent, not blocked', async () => {
    h = await createHarness({ ackTimeoutMs: 1500 });
    await h.api('POST', '/wash-control/start', { wash: 1 });
    h.esp.mutedActions = ['stop'];
    const first = h.api('POST', '/wash-control/stop');
    await waitFor(() => h!.broker.on(CMD).length === 2, 2000, 'first stop published');
    h.esp.mutedActions = [];
    const second = await h.api('POST', '/wash-control/stop');
    expect(h.broker.on(CMD)).toHaveLength(3);
    expect([200, 409]).toContain(second.status); // the machine already stopped, so 409 is a valid answer
    expect((await first).status).toBe(504);
  });
});
