import { Router } from 'express';
import { validate } from '../../core/validate.js';
import { createWashConfigController } from './wash-config.controller.js';
import {
  historyQuerySchema,
  saveSequenceBodySchema,
  saveTimingBodySchema,
  washNumberParamsSchema,
} from './wash-config.schema.js';
import type { WashConfigService } from './wash-config.service.js';

export function createWashConfigRouter(service: WashConfigService): Router {
  const controller = createWashConfigController(service);
  const router = Router();
  router.put(
    '/sequences/:washNumber',
    validate('params', washNumberParamsSchema),
    validate('body', saveSequenceBodySchema),
    controller.saveSequence,
  );
  router.put('/timing', validate('body', saveTimingBodySchema), controller.saveTiming);
  router.get('/history', validate('query', historyQuerySchema), controller.history);
  return router;
}
