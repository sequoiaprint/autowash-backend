// Run tracking rules, tested against an in-memory store with a fake machine and a fake clock.
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger.js';
import type { Config, MachineStatus } from '../src/infrastructure/mqtt/index.js';
import type { MachineService } from '../src/modules/machine/index.js';
import { WashRunTracker } from '../src/modules/wash-runs/index.js';
import { defaultConfig } from './support/fake-engine.js';
import { MemoryRunStore } from './support/memory-store.js';
import { done, idle, inBreak, paused, running, status, stopped } from './support/status.js';

class FakeMachine extends EventEmitter {
  config: Config | null = defaultConfig();
  getConfig() {
    return this.config;
  }
}

let machine: FakeMachine;
let store: MemoryRunStore;
let nowMs: number;
let tracker: WashRunTracker;

const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);

function makeTracker(): WashRunTracker {
  return new WashRunTracker({
    machine: machine as unknown as MachineService,
    store,
    logger: createLogger('silent'),
    now: () => new Date(nowMs),
  });
}

async function feed(...statuses: MachineStatus[]): Promise<void> {
  for (const s of statuses) machine.emit('trackedStatus', s);
  await tracker.idle();
}

beforeEach(async () => {
  machine = new FakeMachine();
  store = new MemoryRunStore();
  nowMs = T0;
  tracker = makeTracker();
  await tracker.start();
});

describe('starting a run', () => {
  it('creates an IN_PROGRESS run with snapshots when the machine goes from inactive to active', async () => {
    await feed(idle());
    await feed(running(0));
    expect(store.runs).toHaveLength(1);
    const run = store.runs[0]!;
    expect(run).toMatchObject({
      washNumber: 1,
      outcome: 'IN_PROGRESS',
      totalSeconds: 900,
      elapsedSeconds: 0,
      breakCount: 0,
      pauseCount: 0,
      linkPauseCount: 0,
      recovered: false,
      endedAt: null,
    });
    expect(run.startedAt.getTime()).toBe(T0);
    expect(run.sequenceSnapshot).toEqual(defaultConfig().washes[0]);
    expect(run.timingSnapshot).toEqual(defaultConfig().timing);
  });

  it('snapshots the sequence of the wash that was started', async () => {
    await feed(idle(), running(0, 3));
    expect(store.runs[0]!.sequenceSnapshot).toEqual(defaultConfig().washes[2]);
  });

  it('counts a wash that begins with a break', async () => {
    await feed(idle(), inBreak(0));
    expect(store.runs[0]).toMatchObject({ breakCount: 1 });
  });

  it('does not create a run from done, stopped or idle', async () => {
    await feed(done(), stopped(), idle());
    expect(store.runs).toHaveLength(0);
  });
});

describe('counters', () => {
  it('counts a break once, even when the status repeats', async () => {
    await feed(idle(), running(0), running(579), inBreak(580), inBreak(580), inBreak(580));
    expect(store.runs[0]!.breakCount).toBe(1);
  });

  it('counts a second break after resuming', async () => {
    await feed(idle(), running(0), inBreak(580), running(580), inBreak(700));
    expect(store.runs[0]!.breakCount).toBe(2);
  });

  it('counts an operator pause in pauseCount', async () => {
    await feed(idle(), running(0), running(30), paused(30, 'operator'), paused(30, 'operator'));
    expect(store.runs[0]).toMatchObject({ pauseCount: 1, linkPauseCount: 0 });
  });

  it('counts a link pause in linkPauseCount', async () => {
    await feed(idle(), running(0), running(30), paused(30, 'link'));
    expect(store.runs[0]).toMatchObject({ pauseCount: 0, linkPauseCount: 1 });
  });

  it('counts each separate pause', async () => {
    await feed(idle(), running(0), paused(30), running(30), paused(60), running(60), paused(90, 'link'));
    expect(store.runs[0]).toMatchObject({ pauseCount: 2, linkPauseCount: 1 });
  });
});

describe('ending a run', () => {
  it('done closes the run as COMPLETED with the full elapsed time', async () => {
    await feed(idle(), running(0), running(899));
    nowMs += 900_000;
    await feed(done());
    expect(store.runs[0]).toMatchObject({ outcome: 'COMPLETED', elapsedSeconds: 900 });
    expect(store.runs[0]!.endedAt?.getTime()).toBe(nowMs);
  });

  it('stopped closes the run as STOPPED', async () => {
    await feed(idle(), running(0), running(120), stopped(121));
    expect(store.runs[0]).toMatchObject({ outcome: 'STOPPED', elapsedSeconds: 121 });
    expect(store.runs[0]!.endedAt).not.toBeNull();
  });

  it('idle while a run is open closes it as INTERRUPTED', async () => {
    await feed(idle(), running(0), running(200), idle());
    expect(store.runs[0]).toMatchObject({ outcome: 'INTERRUPTED', elapsedSeconds: 200 });
  });

  it('a new run can start after the old one ended', async () => {
    await feed(idle(), running(0), done(), running(0));
    expect(store.runs.map((r) => r.outcome)).toEqual(['COMPLETED', 'IN_PROGRESS']);
    expect(store.runs.every((r) => !r.recovered)).toBe(true);
  });
});

describe('a different wash or a sharp drop in elapsed time', () => {
  it('closes the old run as INTERRUPTED and opens a new one when the wash number changes', async () => {
    await feed(idle(), running(0, 1), running(100, 1), running(5, 2));
    expect(store.runs.map((r) => [r.washNumber, r.outcome])).toEqual([
      [1, 'INTERRUPTED'],
      [2, 'IN_PROGRESS'],
    ]);
  });

  it('closes the old run and opens a new one when elapsed drops sharply', async () => {
    await feed(idle(), running(0), running(400), running(3));
    expect(store.runs.map((r) => r.outcome)).toEqual(['INTERRUPTED', 'IN_PROGRESS']);
    expect(store.runs[0]!.elapsedSeconds).toBe(400);
  });

  it('ignores a small drop', async () => {
    await feed(idle(), running(0), running(400), running(399));
    expect(store.runs).toHaveLength(1);
  });

  it('a done status for another wash interrupts the open run', async () => {
    await feed(idle(), running(0, 1), done(2));
    expect(store.runs[0]!.outcome).toBe('INTERRUPTED');
    expect(store.runs).toHaveLength(1);
  });
});

describe('saving elapsed time', () => {
  it('does not write on every status message', async () => {
    await feed(idle(), running(0));
    const baseline = store.updates;
    for (let s = 1; s <= 25; s++) {
      nowMs += 1000;
      await feed(running(s));
    }
    expect(store.updates).toBe(baseline); // 25 seconds, no state change
    expect(store.runs[0]!.elapsedSeconds).toBe(0);
  });

  it('saves at most every 30 seconds', async () => {
    await feed(idle(), running(0));
    const baseline = store.updates;
    for (let s = 1; s <= 65; s++) {
      nowMs += 1000;
      await feed(running(s));
    }
    expect(store.updates - baseline).toBe(2); // at 30 s and 60 s
    expect(store.runs[0]!.elapsedSeconds).toBe(60);
  });

  it('saves on a state change', async () => {
    await feed(idle(), running(0), running(10));
    nowMs += 10_000;
    await feed(paused(10));
    expect(store.runs[0]!.elapsedSeconds).toBe(10);
  });

  it('saves the latest elapsed time when stopped', async () => {
    await feed(idle(), running(0), running(7));
    await tracker.stop();
    expect(store.runs[0]!.elapsedSeconds).toBe(7);
  });
});

describe('duplicate and retained messages', () => {
  it('repeating the same active status does not create duplicates', async () => {
    await feed(idle(), running(50), running(50), running(50));
    expect(store.runs).toHaveLength(1);
  });

  it('repeating the same done status closes once and never creates a run', async () => {
    await feed(idle(), running(0), done(), done(), done());
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.outcome).toBe('COMPLETED');
    expect(store.updates).toBeLessThanOrEqual(2);
  });

  it('repeated stopped and idle do not create runs', async () => {
    await feed(stopped(), stopped(), idle(), idle());
    expect(store.runs).toHaveLength(0);
  });
});

describe('restart recovery', () => {
  async function restart(): Promise<void> {
    await tracker.stop();
    tracker = makeTracker();
    await tracker.start();
  }

  it('continues the open run when the retained status is active and matches', async () => {
    await feed(idle(), running(0), paused(40));
    const id = store.runs[0]!.id;
    const counts = { ...store.runs[0]! };
    await restart();
    await feed(paused(40), paused(40), running(45));
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.id).toBe(id);
    expect(store.runs[0]!.outcome).toBe('IN_PROGRESS');
    expect(store.runs[0]!.pauseCount).toBe(counts.pauseCount); // a repeated paused status is not a new pause
    expect(store.runs[0]!.recovered).toBe(false);
  });

  it('creates a recovered run when active with no open run, with startedAt = now - elapsed', async () => {
    await restart();
    await feed(running(192));
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ recovered: true, outcome: 'IN_PROGRESS', elapsedSeconds: 192 });
    expect(store.runs[0]!.startedAt.getTime()).toBe(T0 - 192_000);
  });

  it('a retained done closes a matching open run but never creates a new run', async () => {
    await feed(idle(), running(0), running(500));
    await restart();
    await feed(done());
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.outcome).toBe('COMPLETED');
    await restart();
    await feed(done());
    expect(store.runs).toHaveLength(1);
  });

  it('a retained stopped closes a matching open run', async () => {
    await feed(idle(), running(0), running(90));
    await restart();
    await feed(stopped(95));
    expect(store.runs[0]).toMatchObject({ outcome: 'STOPPED', elapsedSeconds: 95 });
  });

  it('an idle status after restart interrupts the open run', async () => {
    await feed(idle(), running(0), running(90));
    await restart();
    await feed(idle());
    expect(store.runs[0]!.outcome).toBe('INTERRUPTED');
  });

  it('a status for another wash after restart interrupts the open run and starts a recovered one', async () => {
    await feed(idle(), running(0, 1), running(90, 1));
    await restart();
    await feed(running(20, 3));
    expect(store.runs.map((r) => [r.washNumber, r.outcome, r.recovered])).toEqual([
      [1, 'INTERRUPTED', false],
      [3, 'IN_PROGRESS', true],
    ]);
  });

  it('a restarted wash with the same number but much less elapsed time is a new run', async () => {
    await feed(idle(), running(0), running(120), paused(120));
    await restart();
    await feed(status({ ...running(4), state: 'running' }));
    expect(store.runs.map((r) => r.outcome)).toEqual(['INTERRUPTED', 'IN_PROGRESS']);
  });
});
