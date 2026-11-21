import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { Env } from './config/env.js';
import { createErrorHandler, notFoundHandler } from './core/error-handler.js';
import { createApiRouter, type ApiServices } from './routes.js';

export function createApp(env: Pick<Env, 'CORS_ORIGINS'>, logger: Logger, services?: ApiServices): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1', createApiRouter(services));
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
