// A whole wash through the REST API, the fake broker and the fake ESP, with run history in MySQL.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sleep, waitFor, type Harness } from './support/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const runs = (harness: Harness) => harness.prisma.washRun.findMany({ orderBy: { startedAt: 'asc' } });

/** Moves the fake machine forward and waits for the backend to see the new status. */
async function advance(harness: Harness, seconds: number): Promise<void> {
  harness.esp.advance(seconds);
  const expected = harness.esp.engine.snapshot();
  await waitFor(() => {
    const s = harness.runtime.machine.getStatus();
    return s?.state === expected.state && s.elapsedS === expected.elapsedS;
  }, 3000, `status elapsed ${expected.elapsedS}`);
  await harness.tracked();
}

describe('a complete wash 1', () => {
  it('start, pause, resume, break, finish', async () => {
    h = await createHarness();

    // start
    expect((await h.api('POST', '/wash-control/start', { wash: 1 })).status).toBe(200);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
    await h.tracked();
    let [run] = await runs(h);
    expect(run).toMatchObject({ washNumber: 1, outcome: 'IN_PROGRESS', totalSeconds: 900, recovered: false });

    // live state through the API: values come from the machine
    await advance(h, 30);
    let state = (await h.api('GET', '/machine/state')).body.data as { status: Record<string, unknown> };
    expect(state.status).toMatchObject({ state: 'running', wash: 1, elapsedS: 30, remainingS: 870, step: 'process' });

    // pause
    expect((await h.api('POST', '/wash-control/pause')).status).toBe(200);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'paused', 2000, 'paused');
    await h.tracked();
    [run] = await runs(h);
    expect(run).toMatchObject({ pauseCount: 1, linkPauseCount: 0, outcome: 'IN_PROGRESS' });

    // resume
    expect((await h.api('POST', '/wash-control/resume')).status).toBe(200);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running again');

    // 30 s + 550 s = 580 s: process 300 + air 20 + water 240 + air 20, then the break
    await advance(h, 550);
    state = (await h.api('GET', '/machine/state')).body.data as { status: Record<string, unknown> };
    expect(state.status).toMatchObject({ state: 'break', elapsedS: 580, step: 'break', next: 'uv' });
    [run] = await runs(h);
    expect(run).toMatchObject({ breakCount: 1, outcome: 'IN_PROGRESS' });

    // resume from the break, then run to the end (uv 180 + air 20 + clean 120)
    expect((await h.api('POST', '/wash-control/resume')).status).toBe(200);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'after break');
    await advance(h, 320);
    expect(h.runtime.machine.getStatus()).toMatchObject({ state: 'done', elapsedS: 900, remainingS: 0 });
    await h.tracked();

    const all = await runs(h);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      washNumber: 1,
      outcome: 'COMPLETED',
      totalSeconds: 900,
      elapsedSeconds: 900,
      breakCount: 1,
      pauseCount: 1,
      linkPauseCount: 0,
      recovered: false,
    });
    expect(all[0]!.endedAt).not.toBeNull();
    expect(all[0]!.sequenceSnapshot).toEqual(h.esp.config.washes[0]);
    expect(all[0]!.timingSnapshot).toEqual(h.esp.config.timing);

    // history through the API
    const list = (await h.api('GET', '/wash-runs?washNumber=1&outcome=COMPLETED')).body.data as { items: { id: string }[]; total: number };
    expect(list.total).toBe(1);
    const one = await h.api('GET', `/wash-runs/${list.items[0]!.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: all[0]!.id, outcome: 'COMPLETED' });
  });

  it('stop closes the run as STOPPED', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 2 });
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
    await advance(h, 45);
    expect((await h.api('POST', '/wash-control/stop')).status).toBe(200);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'stopped', 2000, 'stopped');
    await h.tracked();
    const [run] = await runs(h);
    expect(run).toMatchObject({ washNumber: 2, outcome: 'STOPPED', elapsedSeconds: 45 });
  });

  it('a link-loss pause is counted separately', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await advance(h, 20);
    h.esp.linkLossPause();
    await waitFor(() => h!.runtime.machine.getStatus()?.pauseReason === 'link', 2000, 'link pause');
    await h.tracked();
    expect(h.runtime.machine.getStatus()).toMatchObject({ state: 'paused', pauseReason: 'link' });
    const [run] = await runs(h);
    expect(run).toMatchObject({ pauseCount: 0, linkPauseCount: 1 });
    await h.api('POST', '/wash-control/resume');
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'resumed');
  });

  it('a second wash after the first creates a second run', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 2 }); // 3+2 min, no break
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
    await advance(h, 180 + 20 + 120 + 20 + 120); // process, air, water, air, clean
    expect(h.runtime.machine.getStatus()?.state).toBe('done');
    await h.api('POST', '/wash-control/start', { wash: 3 });
    await waitFor(() => h!.runtime.machine.getStatus()?.wash === 3, 2000, 'wash 3');
    await h.tracked();
    expect((await runs(h)).map((r) => [r.washNumber, r.outcome])).toEqual([
      [2, 'COMPLETED'],
      [3, 'IN_PROGRESS'],
    ]);
  });
});

describe('machine goes offline during a wash', () => {
  it('keeps the run open, and continues it when the machine returns with the same wash', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await advance(h, 100);
    const [before] = await runs(h);

    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'offline');
    await sleep(500); // longer than the settle window
    let [during] = await runs(h);
    expect(during).toMatchObject({ id: before!.id, outcome: 'IN_PROGRESS' });

    await h.esp.start(); // same machine, wash still in progress
    await waitFor(() => h!.runtime.machine.getSnapshot().machineOnline, 3000, 'online');
    h.esp.advance(5);
    await advance(h, 5);
    await sleep(500);
    const all = await runs(h);
    expect(all).toHaveLength(1);
    [during] = all;
    expect(during).toMatchObject({ id: before!.id, outcome: 'IN_PROGRESS' });
  });

  it('marks the run INTERRUPTED when the machine returns idle after a reboot', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await advance(h, 100);
    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'offline');
    await h.esp.restart(); // reboots: valves closed, wash not resumed
    await waitFor(() => h!.runtime.machine.getSnapshot().machineOnline, 3000, 'online');
    await waitFor(async () => (await runs(h!))[0]?.outcome === 'INTERRUPTED', 3000, 'interrupted');
    const all = await runs(h);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'INTERRUPTED' });
  });

  it('does not close or create a run from stale retained status while the machine is offline', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await advance(h, 60);
    await h.esp.goOffline();
    await waitFor(() => !h!.runtime.machine.getSnapshot().machineOnline, 3000, 'offline');
    await sleep(600);
    // the retained status on the broker still says "running", and the run stays open
    expect(h.runtime.machine.getStatus()?.state).toBe('running');
    expect((await runs(h))).toHaveLength(1);
    expect((await runs(h))[0]!.outcome).toBe('IN_PROGRESS');
  });
});
