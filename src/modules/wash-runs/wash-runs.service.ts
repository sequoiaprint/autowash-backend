import { AppError } from '../../core/app-error.js';
import type { Page } from '../../core/pagination.js';
import type { WashRun, WashRunFilter, WashRunStore } from './wash-runs.types.js';

export class WashRunsService {
  constructor(private readonly store: WashRunStore) {}

  list(filter: WashRunFilter, page: number, limit: number): Promise<Page<WashRun>> {
    return this.store.list(filter, page, limit);
  }

  async get(id: string): Promise<WashRun> {
    const run = await this.store.findById(id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Wash run not found');
    return run;
  }
}
