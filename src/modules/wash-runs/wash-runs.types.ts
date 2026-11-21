import type { Page } from '../../core/pagination.js';
import type { WashRun } from '../../generated/prisma/client.js';
import type { WashOutcome } from '../../generated/prisma/enums.js';

export type { WashOutcome, WashRun };

export interface NewWashRun {
  washNumber: number;
  startedAt: Date;
  totalSeconds: number;
  elapsedSeconds: number;
  breakCount: number;
  pauseCount: number;
  linkPauseCount: number;
  sequenceSnapshot: unknown;
  timingSnapshot: unknown;
  recovered: boolean;
}

export interface WashRunPatch {
  outcome?: WashOutcome;
  endedAt?: Date;
  elapsedSeconds?: number;
  breakCount?: number;
  pauseCount?: number;
  linkPauseCount?: number;
}

export interface WashRunFilter {
  washNumber?: number | undefined;
  outcome?: WashOutcome | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** Storage used by the run tracker. The Prisma version is the only one used in production. */
export interface WashRunStore {
  findOpen(): Promise<WashRun | null>;
  create(run: NewWashRun): Promise<WashRun>;
  update(id: string, patch: WashRunPatch): Promise<WashRun>;
  findById(id: string): Promise<WashRun | null>;
  list(filter: WashRunFilter, page: number, limit: number): Promise<Page<WashRun>>;
}
