import type { MachineStatus } from '../../src/infrastructure/mqtt/contract.js';

/** Builds a status message with sensible defaults. */
export function status(overrides: Partial<MachineStatus> = {}): MachineStatus {
  return {
    state: 'idle',
    wash: 0,
    elapsedS: 0,
    totalS: 0,
    remainingS: 0,
    stepIndex: 0,
    stepNo: 0,
    stepTotal: 0,
    step: null,
    stepRemainingS: 0,
    pulse: 0,
    pulseTotal: 0,
    valve: 'off',
    nextReleaseS: 0,
    next: null,
    pauseReason: 'none',
    ...overrides,
  };
}

export const running = (elapsedS = 0, wash = 1): MachineStatus =>
  status({ state: 'running', wash, elapsedS, totalS: 900, remainingS: 900 - elapsedS, step: 'process', stepTotal: 5, stepNo: 1 });
export const paused = (elapsedS = 30, reason: 'operator' | 'link' = 'operator', wash = 1): MachineStatus =>
  ({ ...running(elapsedS, wash), state: 'paused', pauseReason: reason });
export const inBreak = (elapsedS = 580, wash = 1): MachineStatus =>
  ({ ...running(elapsedS, wash), state: 'break', step: 'break' });
export const done = (wash = 1): MachineStatus =>
  status({ state: 'done', wash, elapsedS: 900, totalS: 900, remainingS: 0 });
export const stopped = (elapsedS = 120, wash = 1): MachineStatus =>
  status({ state: 'stopped', wash, elapsedS, totalS: 900, remainingS: 900 - elapsedS });
export const idle = (): MachineStatus => status();
