import { createApp } from './app.js';
import { loadConfig, ConfigError } from './config.js';
import { createPool, createReadiness } from './db.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { createPrisma } from './prisma.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // The logger needs configuration, so startup failures go straight to stderr.
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.env.logLevel);
  const pool = createPool(config.env.databaseUrl);
  const app = createApp({
    config,
    logger,
    metrics: new Metrics(),
    readiness: createReadiness(pool, config.env.migrationsDir),
    db: createPrisma(pool),
  });

  app.listen(config.env.port, config.env.host, () => {
    logger.info({ port: config.env.port }, 'hook-relay listening');
  });
}

main();
