import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Readiness } from './db.js';
import { errorHandler, notFoundHandler, requestContext } from './http.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { Db } from './prisma.js';
import { healthRouter } from './routes/health.js';
import { ingestRouter } from './routes/ingest.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  readiness: Readiness;
  db: Db;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(requestContext(deps.logger));
  app.use(healthRouter(deps.readiness, deps.logger));
  app.use(
    ingestRouter({
      relay: deps.config.relay,
      db: deps.db,
      logger: deps.logger,
      metrics: deps.metrics,
      now: deps.now ?? Date.now,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
