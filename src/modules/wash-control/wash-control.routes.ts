import { Router } from 'express';
import { validate } from '../../core/validate.js';
import { createWashControlController } from './wash-control.controller.js';
import { startBodySchema } from './wash-control.schema.js';
import type { WashControlService } from './wash-control.service.js';

export function createWashControlRouter(service: WashControlService): Router {
  const controller = createWashControlController(service);
  const router = Router();
  router.post('/start', validate('body', startBodySchema), controller.start);
  router.post('/pause', controller.pause);
  router.post('/resume', controller.resume);
  router.post('/stop', controller.stop);
  return router;
}
