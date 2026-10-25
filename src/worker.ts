import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db.js';
import { createForwarder } from './delivery/forward.js';
import { Worker } from './delivery/worker.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { createPrisma } from './prisma.js';
import { installShutdown } from './shutdown.js';

/** Standalone delivery worker: `node dist/worker.js`. Safe to run alongside other workers. */
function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.env.logLevel);
  const pool = createPool(config.env.databaseUrl);
  const db = createPrisma(pool);
  const forwarder = createForwarder({
    network: config.relay.network,
    relaySigningSecret: config.env.relaySigningSecret,
  });
  const worker = new Worker({ db, config, forwarder, logger, metrics: new Metrics() });
  worker.start();
  logger.info('hook-relay worker started');

  installShutdown({
    logger,
    graceMs: config.env.shutdownGraceMs,
    steps: [
      { name: 'worker', run: (graceMs) => worker.stop(graceMs) },
      { name: 'forwarder', run: () => forwarder.close() },
      { name: 'database', run: () => db.$disconnect() },
      { name: 'pool', run: () => pool.end() },
    ],
  });
}

main();
