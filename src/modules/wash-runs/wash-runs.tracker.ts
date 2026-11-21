import type { Logger } from 'pino';
import { isActiveState, type MachineStatus, type RunState } from '../../infrastructure/mqtt/index.js';
import type { MachineService } from '../machine/index.js';
import type { WashRunPatch, WashRunStore } from './wash-runs.types.js';

/** elapsedS may fall this far behind the stored value before the run counts as restarted. */
const SHARP_DROP_S = 10;
/** Elapsed time is saved on state changes and at most this often otherwise. */
const ELAPSED_SAVE_MS = 30_000;

interface OpenRun {
  id: string;
  washNumber: number;
  lastElapsed: number;
  savedElapsed: number;
  lastState: RunState | null;
  lastReason: MachineStatus['pauseReason'] | null;
  lastSavedAt: number;
  breakCount: number;
  pauseCount: number;
  linkPauseCount: number;
}

export interface TrackerDeps {
  machine: Pick<MachineService, 'on' | 'off' | 'getConfig'>;
  store: WashRunStore;
  logger: Logger;
  now?: () => Date;
}

/**
 * Turns machine statuses into wash run history. Only statuses the machine service marks as safe
 * ("trackedStatus") are used, so stale retained messages never create, recover or close a run.
 */
export class WashRunTracker {
  private open: OpenRun | null = null;
  private lastProcessed: MachineStatus | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly listener = (status: MachineStatus): void => this.enqueue(status);

  constructor(private readonly deps: TrackerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Loads the run that was open before a restart, then starts listening. */
  async start(): Promise<void> {
    const run = await this.deps.store.findOpen();
    if (run) {
      this.open = {
        id: run.id,
        washNumber: run.washNumber,
        lastElapsed: run.elapsedSeconds,
        savedElapsed: run.elapsedSeconds,
        lastState: null,
        lastReason: null,
        lastSavedAt: this.now().getTime(),
        breakCount: run.breakCount,
        pauseCount: run.pauseCount,
        linkPauseCount: run.linkPauseCount,
      };
    }
    this.deps.machine.on('trackedStatus', this.listener);
  }

  /** Stops listening, finishes pending work and saves the latest elapsed time. */
  async stop(): Promise<void> {
    this.deps.machine.off('trackedStatus', this.listener);
    await this.chain;
    const open = this.open;
    if (open && open.lastElapsed !== open.savedElapsed) {
      try {
        await this.deps.store.update(open.id, { elapsedSeconds: open.lastElapsed });
        open.savedElapsed = open.lastElapsed;
      } catch (err) {
        this.deps.logger.error({ err }, 'Could not save elapsed time on shutdown');
      }
    }
  }

  /** Resolves when all queued statuses have been processed. For tests. */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(status: MachineStatus): void {
    this.chain = this.chain
      .then(() => this.handle(status))
      .catch((err: unknown) => this.deps.logger.error({ err }, 'Run tracking failed'));
  }

  private async handle(s: MachineStatus): Promise<void> {
    const open = this.open;
    if (open) {
      if (isActiveState(s.state)) {
        if (s.wash !== open.washNumber || s.elapsedS + SHARP_DROP_S < open.lastElapsed) {
          await this.close(open, 'INTERRUPTED', open.lastElapsed);
          await this.create(s);
        } else {
          await this.progress(open, s);
        }
      } else if (s.state === 'done' || s.state === 'stopped') {
        if (s.wash === open.washNumber) {
          await this.close(open, s.state === 'done' ? 'COMPLETED' : 'STOPPED', s.state === 'done' ? s.totalS : s.elapsedS);
        } else {
          await this.close(open, 'INTERRUPTED', open.lastElapsed);
        }
      } else {
        // idle while a run is open: the machine restarted or lost the wash
        await this.close(open, 'INTERRUPTED', open.lastElapsed);
      }
    } else if (isActiveState(s.state)) {
      await this.create(s);
    }
    // done / stopped / idle with no open run never creates anything
    this.lastProcessed = s;
  }

  private async create(s: MachineStatus): Promise<void> {
    const config = this.deps.machine.getConfig();
    if (!config) this.deps.logger.warn('Run started while the config is unknown. Snapshots are empty');
    // Seen going from inactive to active: a normal start. Otherwise the start was missed.
    const live = this.lastProcessed !== null && !isActiveState(this.lastProcessed.state);
    const nowMs = this.now().getTime();
    const counts = {
      breakCount: s.state === 'break' ? 1 : 0,
      pauseCount: s.state === 'paused' && s.pauseReason !== 'link' ? 1 : 0,
      linkPauseCount: s.state === 'paused' && s.pauseReason === 'link' ? 1 : 0,
    };
    const run = await this.deps.store.create({
      washNumber: s.wash,
      startedAt: live ? new Date(nowMs) : new Date(nowMs - s.elapsedS * 1000),
      totalSeconds: s.totalS,
      elapsedSeconds: s.elapsedS,
      ...counts,
      sequenceSnapshot: config?.washes[s.wash - 1] ?? [],
      timingSnapshot: config?.timing ?? {},
      recovered: !live,
    });
    this.open = {
      id: run.id,
      washNumber: s.wash,
      lastElapsed: s.elapsedS,
      savedElapsed: s.elapsedS,
      lastState: s.state,
      lastReason: s.pauseReason,
      lastSavedAt: nowMs,
      ...counts,
    };
  }

  private async progress(open: OpenRun, s: MachineStatus): Promise<void> {
    const prev = open.lastState;
    const patch: WashRunPatch = {};
    let breakCount = open.breakCount;
    let pauseCount = open.pauseCount;
    let linkPauseCount = open.linkPauseCount;

    if (prev !== null) {
      if (s.state === 'break' && prev !== 'break') breakCount += 1;
      if (s.state === 'paused' && prev === 'running') {
        if (s.pauseReason === 'link') linkPauseCount += 1;
        else pauseCount += 1;
      }
    }
    if (breakCount !== open.breakCount) patch.breakCount = breakCount;
    if (pauseCount !== open.pauseCount) patch.pauseCount = pauseCount;
    if (linkPauseCount !== open.linkPauseCount) patch.linkPauseCount = linkPauseCount;

    const nowMs = this.now().getTime();
    const stateChanged = s.state !== prev || s.pauseReason !== open.lastReason;
    const due = nowMs - open.lastSavedAt >= ELAPSED_SAVE_MS;
    const elapsedChanged = s.elapsedS !== open.savedElapsed;

    open.lastElapsed = s.elapsedS;
    open.lastState = s.state;
    open.lastReason = s.pauseReason;

    if (Object.keys(patch).length > 0 || ((stateChanged || due) && elapsedChanged)) {
      patch.elapsedSeconds = s.elapsedS;
      await this.deps.store.update(open.id, patch);
      open.savedElapsed = s.elapsedS;
      open.lastSavedAt = nowMs;
      open.breakCount = breakCount;
      open.pauseCount = pauseCount;
      open.linkPauseCount = linkPauseCount;
    }
  }

  private async close(open: OpenRun, outcome: 'COMPLETED' | 'STOPPED' | 'INTERRUPTED', elapsed: number): Promise<void> {
    await this.deps.store.update(open.id, { outcome, endedAt: this.now(), elapsedSeconds: elapsed });
    this.open = null;
  }
}
