import type { RequestHandler } from 'express';
import { ok } from '../../core/respond.js';
import type { ListRunsQuery, RunIdParams } from './wash-runs.schema.js';
import type { WashRunsService } from './wash-runs.service.js';

export function createWashRunsController(service: WashRunsService): Record<'list' | 'get', RequestHandler> {
  return {
    list: async (_req, res) => {
      const { page, limit, ...filter } = res.locals.query as ListRunsQuery;
      ok(res, await service.list(filter, page, limit));
    },
    get: async (_req, res) => {
      const { id } = res.locals.params as RunIdParams;
      ok(res, await service.get(id));
    },
  };
}
