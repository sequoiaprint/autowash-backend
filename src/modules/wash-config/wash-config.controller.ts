import type { RequestHandler } from 'express';
import { ok } from '../../core/respond.js';
import type {
  HistoryQuery,
  SaveSequenceBody,
  SaveTimingBody,
  WashNumberParams,
} from './wash-config.schema.js';
import type { WashConfigService } from './wash-config.service.js';

export function createWashConfigController(service: WashConfigService): Record<
  'saveSequence' | 'saveTiming' | 'history',
  RequestHandler
> {
  return {
    saveSequence: async (req, res) => {
      const { washNumber } = res.locals.params as WashNumberParams;
      const { steps } = req.body as SaveSequenceBody;
      const config = await service.saveSequence(washNumber, steps);
      ok(res, { config });
    },
    saveTiming: async (req, res) => {
      const { timing } = req.body as SaveTimingBody;
      const config = await service.saveTiming(timing);
      ok(res, { config });
    },
    history: async (_req, res) => {
      const { page, limit } = res.locals.query as HistoryQuery;
      ok(res, await service.history(page, limit));
    },
  };
}
