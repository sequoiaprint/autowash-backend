// A TypeScript port of the ESP32 wash engine, for the fake ESP only.
// It follows the firmware's plan, state machine and status values.
import type { Config, MachineStatus, RunState } from '../../src/infrastructure/mqtt/contract.js';

type PlanType = 'process' | 'water' | 'uv' | 'clean' | 'air' | 'break';
type PauseReason = 'none' | 'operator' | 'link';

interface PlanEntry {
  type: PlanType;
  durMs: number;
  atMs: number;
}

interface Pulse {
  releaseMs: number;
  waitS: number;
}

export function defaultConfig(): Config {
  return {
    washes: [
      [{ t: 'process', m: 5 }, { t: 'water', m: 4 }, { t: 'break' }, { t: 'uv', m: 3 }],
      [{ t: 'process', m: 3 }, { t: 'water', m: 2 }],
      [{ t: 'uv', m: 4 }, { t: 'water', m: 3 }],
      [{ t: 'process', m: 6 }, { t: 'water', m: 3 }, { t: 'uv', m: 2 }, { t: 'water', m: 2 }],
    ],
    timing: {
      process: { releaseMs: 100, waitS: 30 },
      water: { releaseMs: 200, waitS: 20 },
      uv: { releaseMs: 100, waitS: 30 },
      clean: { releaseMs: 300, waitS: 15, durMin: 2 },
      air: { sec: 20 },
    },
  };
}

export class FakeEngine {
  state: RunState = 'idle';
  private reason: PauseReason = 'none';
  private wash = 0;
  private elapsedMs = 0;
  private totalMs = 0;
  private index = 0;
  private plan: PlanEntry[] = [];
  private pulses: Record<'process' | 'water' | 'uv' | 'clean', Pulse> = {
    process: { releaseMs: 0, waitS: 1 },
    water: { releaseMs: 0, waitS: 1 },
    uv: { releaseMs: 0, waitS: 1 },
    clean: { releaseMs: 0, waitS: 1 },
  };

  get isActive(): boolean {
    return this.state === 'running' || this.state === 'paused' || this.state === 'break';
  }

  /** The sequence and timings are copied, so later saves cannot change a running wash. */
  start(wash: number, cfg: Config): boolean {
    if (this.isActive || wash < 1 || wash > 4) return false;
    this.pulses = {
      process: cfg.timing.process,
      water: cfg.timing.water,
      uv: cfg.timing.uv,
      clean: { releaseMs: cfg.timing.clean.releaseMs, waitS: cfg.timing.clean.waitS },
    };
    this.plan = [];
    this.totalMs = 0;
    for (const step of cfg.washes[wash - 1] ?? []) {
      if (step.t === 'break') {
        this.addPlan('break', 0);
      } else {
        this.addPlan(step.t, step.m * 60_000);
        this.addPlan('air', cfg.timing.air.sec * 1000);
      }
    }
    this.addPlan('clean', cfg.timing.clean.durMin * 60_000);
    this.wash = wash;
    this.index = 0;
    this.elapsedMs = 0;
    this.reason = 'none';
    this.state = 'running';
    this.advance();
    return true;
  }

  pause(reason: 'operator' | 'link'): boolean {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    this.reason = reason;
    return true;
  }

  resume(): boolean {
    if (this.state === 'break') this.index++;
    else if (this.state !== 'paused') return false;
    this.reason = 'none';
    this.state = 'running';
    this.advance();
    return true;
  }

  stop(): boolean {
    if (!this.isActive) return false;
    this.state = 'stopped';
    this.reason = 'none';
    return true;
  }

  /** A restart closes all valves and does not resume the wash. */
  reboot(): void {
    this.state = 'idle';
    this.reason = 'none';
    this.wash = 0;
    this.elapsedMs = 0;
    this.totalMs = 0;
    this.index = 0;
    this.plan = [];
  }

  tick(dtMs: number): void {
    if (this.state !== 'running') return;
    this.elapsedMs += dtMs;
    this.advance();
  }

  snapshot(): MachineStatus {
    const elapsedS = Math.floor(this.elapsedMs / 1000);
    const totalS = Math.floor(this.totalMs / 1000);
    let stepTotal = 0;
    let stepNo = 0;
    this.plan.forEach((e, i) => {
      if (e.type === 'air') return;
      stepTotal++;
      if (i <= this.index) stepNo++;
    });
    const status: MachineStatus = {
      state: this.state,
      wash: this.wash,
      elapsedS,
      totalS,
      remainingS: totalS - elapsedS,
      stepIndex: this.index,
      stepNo,
      stepTotal,
      step: null,
      stepRemainingS: 0,
      pulse: 0,
      pulseTotal: 0,
      valve: 'off',
      nextReleaseS: 0,
      next: null,
      pauseReason: this.reason,
    };
    const entry = this.plan[this.index];
    if (this.wash === 0 || !entry) return status;

    const into = this.elapsedMs - entry.atMs;
    status.step = entry.type;
    status.stepRemainingS = Math.ceil(Math.max(0, entry.durMs - into) / 1000);
    status.next = this.plan[this.index + 1]?.type ?? null;
    if (entry.type !== 'air' && entry.type !== 'break') {
      const p = this.pulses[entry.type];
      const cycle = p.releaseMs + p.waitS * 1000;
      const pos = into % cycle;
      status.pulseTotal = Math.ceil(entry.durMs / cycle);
      status.pulse = Math.min(Math.floor(into / cycle) + 1, status.pulseTotal);
      if (this.state === 'running') {
        status.valve = pos < p.releaseMs ? 'release' : 'wait';
        status.nextReleaseS = Math.ceil((pos < p.releaseMs ? 0 : cycle - pos) / 1000);
      }
    } else if (entry.type === 'air' && this.state === 'running') {
      status.valve = 'air';
    }
    return status;
  }

  private addPlan(type: PlanType, durMs: number): void {
    this.plan.push({ type, durMs, atMs: this.totalMs });
    this.totalMs += durMs;
  }

  private advance(): void {
    while (this.index < this.plan.length) {
      const e = this.plan[this.index]!;
      if (e.type === 'break') {
        this.elapsedMs = e.atMs;
        this.state = 'break';
        return;
      }
      if (this.elapsedMs < e.atMs + e.durMs) return;
      this.index++;
    }
    this.elapsedMs = this.totalMs;
    this.state = 'done';
  }
}
