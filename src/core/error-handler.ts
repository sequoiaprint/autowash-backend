import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from './app-error.js';
import { fail } from './respond.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      fail(res, err.status, err.code, err.message);
      return;
    }
    // body-parser errors carry a 4xx status
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      fail(res, status, 'BAD_REQUEST', 'Malformed request');
      return;
    }
    logger.error({ err }, 'Unhandled error');
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
  };
}
