import { Router } from 'express';
import { createMachineController } from './machine.controller.js';
import type { MachineService } from './machine.service.js';

export function createMachineRouter(service: MachineService): Router {
  const controller = createMachineController(service);
  const router = Router();
  router.get('/state', controller.getState);
  return router;
}
