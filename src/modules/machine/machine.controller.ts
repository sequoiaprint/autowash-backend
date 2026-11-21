import type { RequestHandler } from 'express';
import { ok } from '../../core/respond.js';
import type { MachineService } from './machine.service.js';

export function createMachineController(service: MachineService): { getState: RequestHandler } {
  return {
    getState: (_req, res) => ok(res, service.getSnapshot()),
  };
}
