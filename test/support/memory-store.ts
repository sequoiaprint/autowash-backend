import { randomUUID } from 'node:crypto';
import type { Page } from '../../src/core/pagination.js';
import type {
  NewWashRun,
  WashRun,
  WashRunFilter,
  WashRunPatch,
  WashRunStore,
} from '../../src/modules/wash-runs/wash-runs.types.js';

/** In-memory run store for the tracker rule tests. Counts writes. */
export class MemoryRunStore implements WashRunStore {
  runs: WashRun[] = [];
  updates = 0;

  findOpen(): Promise<WashRun | null> {
    const open = this.runs.filter((r) => r.outcome === 'IN_PROGRESS').sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return Promise.resolve(open[0] ?? null);
  }

  create(run: NewWashRun): Promise<WashRun> {
    const now = new Date();
    const record: WashRun = {
      id: randomUUID(),
      outcome: 'IN_PROGRESS',
      endedAt: null,
      createdAt: now,
      updatedAt: now,
      ...run,
      sequenceSnapshot: run.sequenceSnapshot as WashRun['sequenceSnapshot'],
      timingSnapshot: run.timingSnapshot as WashRun['timingSnapshot'],
    };
    this.runs.push(record);
    return Promise.resolve(record);
  }

  update(id: string, patch: WashRunPatch): Promise<WashRun> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return Promise.reject(new Error('not found'));
    Object.assign(run, patch);
    this.updates++;
    return Promise.resolve(run);
  }

  findById(id: string): Promise<WashRun | null> {
    return Promise.resolve(this.runs.find((r) => r.id === id) ?? null);
  }

  list(_filter: WashRunFilter, page: number, limit: number): Promise<Page<WashRun>> {
    return Promise.resolve({ items: this.runs, page, limit, total: this.runs.length });
  }
}
