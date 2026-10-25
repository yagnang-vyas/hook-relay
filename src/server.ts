import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool, createReadiness } from './db.js';
import { createForwarder } from './delivery/forward.js';
import { Worker } from './delivery/worker.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { createPrisma } from './prisma.js';
import { RetentionJob } from './retention.js';
import { installShutdown, type ShutdownStep } from './shutdown.js';

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
  const metrics = new Metrics();
  const pool = createPool(config.env.databaseUrl, config.env.databaseSchema);
  const db = createPrisma(pool, config.env.databaseSchema);
  const app = createApp({
    config,
    logger,
    metrics,
    readiness: createReadiness(pool, config.env.migrationsDir),
    db,
  });

  const server: Server = app.listen(config.env.port, config.env.host, () => {
    logger.info({ port: config.env.port }, 'hook-relay listening');
  });

  const forwarder = createForwarder({
    network: config.relay.network,
    relaySigningSecret: config.env.relaySigningSecret,
  });
  const worker = config.env.workerEnabled
    ? new Worker({ db, config, forwarder, logger, metrics })
    : undefined;
  worker?.start();

  const retention = new RetentionJob(db, config.relay.retentionDays, logger);
  retention.start();

  const steps: ShutdownStep[] = [
    {
      name: 'http-server',
      run: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          // Keep-alive sockets would otherwise hold close() open until they time out.
          server.closeIdleConnections();
        }),
    },
  ];
  if (worker !== undefined) {
    steps.push({ name: 'worker', run: (graceMs) => worker.stop(graceMs) });
  }
  steps.push(
    { name: 'retention', run: () => retention.stop() },
    { name: 'forwarder', run: () => forwarder.close() },
    { name: 'database', run: () => db.$disconnect() },
    { name: 'pool', run: () => pool.end() },
  );
  installShutdown({ logger, graceMs: config.env.shutdownGraceMs, steps });
}

main();
