import type { RequestHandler } from 'express';
import { ok } from '../../core/respond.js';

export const getHealth: RequestHandler = (_req, res) => {
  ok(res, { status: 'ok' });
};
