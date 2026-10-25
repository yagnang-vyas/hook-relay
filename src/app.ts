import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Readiness } from './db.js';
import { errorHandler, notFoundHandler, requestContext } from './http.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  readiness: Readiness;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(requestContext(deps.logger));
  app.use(healthRouter(deps.readiness, deps.logger));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
