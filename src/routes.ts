import { Router } from 'express';
import { healthRouter } from './modules/health/index.js';
import { createMachineRouter, type MachineService } from './modules/machine/index.js';
import { createWashConfigRouter, type WashConfigService } from './modules/wash-config/index.js';
import { createWashControlRouter, type WashControlService } from './modules/wash-control/index.js';
import { createWashRunsRouter, type WashRunsService } from './modules/wash-runs/index.js';

export interface ApiServices {
  machine: MachineService;
  washConfig: WashConfigService;
  washControl: WashControlService;
  washRuns: WashRunsService;
}

export function createApiRouter(services?: ApiServices): Router {
  const router = Router();
  router.use('/health', healthRouter);
  if (services) {
    router.use('/machine', createMachineRouter(services.machine));
    router.use('/wash-config', createWashConfigRouter(services.washConfig));
    router.use('/wash-control', createWashControlRouter(services.washControl));
    router.use('/wash-runs', createWashRunsRouter(services.washRuns));
  }
  return router;
}
