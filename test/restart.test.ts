// Backend restart during and after a wash, with the retained status left on the broker.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sleep, waitFor, type Harness } from './support/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const runs = (harness: Harness) => harness.prisma.washRun.findMany({ orderBy: { startedAt: 'asc' } });

async function restartBackend(harness: Harness): Promise<void> {
  await harness.stopBackend();
  await harness.startBackend();
  await harness.untilReady();
}

async function startWash(harness: Harness, seconds: number, wash = 1): Promise<void> {
  await harness.api('POST', '/wash-control/start', { wash });
  await waitFor(() => harness.runtime.machine.getStatus()?.state === 'running', 2000, 'running');
  harness.esp.advance(seconds);
  await waitFor(() => harness.runtime.machine.getStatus()?.elapsedS === seconds, 3000, 'elapsed');
  await harness.tracked();
}

describe('restart during a wash', () => {
  it('continues the open run instead of creating a new one', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 120);
    const [before] = await runs(h);

    await restartBackend(h);
    h.esp.advance(10); // a live status after the restart
    await waitFor(() => h!.runtime.machine.getStatus()?.elapsedS === 130, 3000, 'status');
    await sleep(400);
    await h.tracked();

    const all = await runs(h);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before!.id, outcome: 'IN_PROGRESS', recovered: false });
  });

  it('continues the run using only the retained status when the machine is quiet', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 120);
    const [before] = await runs(h);
    await h.api('POST', '/wash-control/pause'); // paused: the ESP publishes nothing more
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'paused', 2000, 'paused');
    await h.tracked();

    await restartBackend(h);
    await sleep(500); // settle window passes, the retained status is used
    await h.tracked();
    const all = await runs(h);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before!.id, outcome: 'IN_PROGRESS', pauseCount: 1 }); // not counted twice
  });

  it('saves the latest elapsed time on a graceful stop', async () => {
    h = await createHarness();
    await startWash(h, 5);
    h.esp.advance(20);
    await waitFor(() => h!.runtime.machine.getStatus()?.elapsedS === 25, 3000, 'status');
    await h.tracked();
    expect((await runs(h))[0]!.elapsedSeconds).toBeLessThan(25); // not saved on every message
    await h.stopBackend();
    expect((await runs(h))[0]!.elapsedSeconds).toBe(25);
    await h.startBackend(); // so the harness can clean up
  });

  it('creates a recovered run when the wash is active but no run is open', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 192);
    await h.stopBackend();
    await h.prisma.washRun.deleteMany(); // the run was never recorded
    await h.startBackend();
    await h.untilReady();
    await waitFor(async () => (await runs(h!)).length === 1, 3000, 'recovered run');
    const [run] = await runs(h);
    expect(run).toMatchObject({ washNumber: 1, outcome: 'IN_PROGRESS', recovered: true });
    const startedAgo = Date.now() - run!.startedAt.getTime();
    expect(startedAgo).toBeGreaterThan(190_000);
    expect(startedAgo).toBeLessThan(200_000);
  });
});

describe('restart after a wash ended', () => {
  it('a retained done status closes a matching open run and never creates a new one', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 10, 2);
    await h.stopBackend();
    h.esp.advance(450); // wash 2 is 460 s long: it finishes while the backend is down
    await sleep(100);
    expect(h.esp.engine.state).toBe('done');
    await h.startBackend();
    await h.untilReady();
    await waitFor(async () => (await runs(h!))[0]?.outcome === 'COMPLETED', 3000, 'completed');
    expect(await runs(h)).toHaveLength(1);

    // restart again with the same retained "done": nothing new
    await restartBackend(h);
    await sleep(500);
    await h.tracked();
    const all = await runs(h);
    expect(all).toHaveLength(1);
    expect(all[0]!.outcome).toBe('COMPLETED');
  });

  it('a retained done with no open run creates nothing', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 10, 2);
    h.esp.advance(450);
    await waitFor(() => h!.runtime.machine.getStatus()?.state === 'done', 3000, 'done');
    await h.tracked();
    await h.stopBackend();
    await h.prisma.washRun.deleteMany();
    await h.startBackend();
    await h.untilReady();
    await sleep(500);
    expect(await runs(h)).toHaveLength(0);
  });

  it('a retained stopped status closes a matching open run', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 30);
    await h.stopBackend();
    await h.esp.shutdown();
    await h.esp.start(); // still the same wash...
    h.esp.engine.stop();
    h.esp.publishStatusNow();
    await h.startBackend();
    await h.untilReady();
    await waitFor(async () => (await runs(h!))[0]?.outcome === 'STOPPED', 3000, 'stopped');
  });

  it('an idle machine after restart interrupts the open run', async () => {
    h = await createHarness({ settleMs: 200 });
    await startWash(h, 30);
    await h.stopBackend();
    await h.esp.restart(); // reboot while the backend is down
    await h.startBackend();
    await h.untilReady();
    await waitFor(async () => (await runs(h!))[0]?.outcome === 'INTERRUPTED', 3000, 'interrupted');
  });
});
