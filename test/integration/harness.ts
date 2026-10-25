import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createReadiness } from '../../src/db.js';
import { applyMigrations } from '../../src/migrate.js';
import { createForwarder, type Forwarder } from '../../src/delivery/forward.js';
import { Worker } from '../../src/delivery/worker.js';
import { Metrics } from '../../src/metrics.js';
import { persistEvent } from '../../src/store/events.js';
import { createPrisma, type Db } from '../../src/prisma.js';
import {
  captureLogger,
  testConfig,
  type CapturedLogger,
  type TestConfigOptions,
} from '../helpers.js';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

export interface TestDb {
  pool: pg.Pool;
  db: Db;
  schema: string;
  databaseUrl: string;
  teardown: () => Promise<void>;
  /** Removes all rows between tests, keeping the schema. */
  reset: () => Promise<void>;
}

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL must point at a PostgreSQL database to run integration tests');
  }
  return url;
}

/**
 * Creates an isolated schema, applies every migration to it, and returns a pool and Prisma
 * client scoped to it. Each test file calls this once, so files never share state.
 */
export async function setupTestDb(): Promise<TestDb> {
  const databaseUrl = requireDatabaseUrl();
  const schema = `t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    options: `-c search_path=${schema}`,
  });

  await applyMigrations(pool, MIGRATIONS_DIR);

  const db = createPrisma(pool, schema);
  return {
    pool,
    db,
    schema,
    databaseUrl,
    reset: async () => {
      await pool.query('TRUNCATE attempts, deliveries, events CASCADE');
    },
    teardown: async () => {
      await db.$disconnect();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export interface TestApp {
  app: Express;
  config: Config;
  metrics: Metrics;
  logs: CapturedLogger;
}

export function createTestApp(
  testDb: Pick<TestDb, 'db' | 'pool'>,
  options: TestConfigOptions & { now?: () => number; db?: Db } = {},
): TestApp {
  const config = testConfig(options);
  const logs = captureLogger();
  const metrics = new Metrics();
  const app = createApp({
    config,
    logger: logs.logger,
    metrics,
    readiness: createReadiness(testDb.pool, config.env.migrationsDir),
    db: options.db ?? testDb.db,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { app, config, metrics, logs };
}

export interface SeedOptions {
  sourceId?: string;
  deliveryId?: string;
  body?: Buffer | string;
  contentType?: string | null;
  targetIds?: string[];
}

/** Stores an event with pending deliveries exactly as the ingest route would. */
export async function seedEvent(db: Db, options: SeedOptions = {}): Promise<string> {
  const result = await persistEvent(db, {
    sourceId: options.sourceId ?? 'github',
    deliveryId: options.deliveryId ?? `seed-${randomBytes(6).toString('hex')}`,
    generatedId: false,
    headers: {},
    contentType: options.contentType === undefined ? 'application/json' : options.contentType,
    body: Buffer.from(options.body ?? '{"seed":true}'),
    targetIds: options.targetIds ?? ['orders'],
  });
  if (result.status !== 'accepted') throw new Error('seed produced a duplicate');
  return result.eventId;
}

/** Makes every queued delivery due now, skipping the backoff wait. */
export async function makeDue(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET next_attempt_at = now() WHERE status IN ('pending', 'retrying')`,
  );
}

export interface WorkerContext {
  worker: Worker;
  forwarder: Forwarder;
  config: Config;
  logs: CapturedLogger;
  metrics: Metrics;
}

export function createTestWorker(
  testDb: Pick<TestDb, 'db'>,
  options: TestConfigOptions & {
    random?: () => number;
    blockPrivate?: boolean;
    leaseSweepIntervalMs?: number;
    forwarder?: Forwarder;
  } = {},
): WorkerContext {
  const config = testConfig({
    ...options,
    ...(options.blockPrivate === true ? { allowPrivateTargets: [] } : {}),
  });
  const logs = captureLogger();
  const metrics = new Metrics();
  const forwarder =
    options.forwarder ??
    createForwarder({
      network: config.relay.network,
      relaySigningSecret: config.env.relaySigningSecret,
    });
  const worker = new Worker({
    db: testDb.db,
    config,
    forwarder,
    logger: logs.logger,
    metrics,
    ...(options.random !== undefined ? { random: options.random } : {}),
    leaseSweepIntervalMs: options.leaseSweepIntervalMs ?? 0,
  });
  return { worker, forwarder, config, logs, metrics };
}
