import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './app-error.js';

type Source = 'body' | 'query' | 'params';

/** Validates one part of the request. Express 5 makes req.query read-only, so the parsed value goes in res.locals. */
export function validate(source: Source, schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.') || source}: ${issue.message}`)
        .join('; ');
      next(new AppError(400, 'VALIDATION_ERROR', message));
      return;
    }
    res.locals[source] = result.data;
    next();
  };
}
