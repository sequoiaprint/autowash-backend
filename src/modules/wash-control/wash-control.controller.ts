import type { RequestHandler } from 'express';
import { ok } from '../../core/respond.js';
import type { StartBody } from './wash-control.schema.js';
import type { WashControlService } from './wash-control.service.js';

export function createWashControlController(service: WashControlService): Record<
  'start' | 'pause' | 'resume' | 'stop',
  RequestHandler
> {
  return {
    start: async (req, res) => {
      const { wash } = req.body as StartBody;
      await service.start(wash);
      ok(res, { action: 'start', wash });
    },
    pause: async (_req, res) => {
      await service.pause();
      ok(res, { action: 'pause' });
    },
    resume: async (_req, res) => {
      await service.resume();
      ok(res, { action: 'resume' });
    },
    stop: async (_req, res) => {
      await service.stop();
      ok(res, { action: 'stop' });
    },
  };
}
