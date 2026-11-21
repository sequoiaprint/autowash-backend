import { Router } from 'express';
import { validate } from '../../core/validate.js';
import { createWashRunsController } from './wash-runs.controller.js';
import { listRunsQuerySchema, runIdParamsSchema } from './wash-runs.schema.js';
import type { WashRunsService } from './wash-runs.service.js';

export function createWashRunsRouter(service: WashRunsService): Router {
  const controller = createWashRunsController(service);
  const router = Router();
  router.get('/', validate('query', listRunsQuerySchema), controller.list);
  router.get('/:id', validate('params', runIdParamsSchema), controller.get);
  return router;
}
