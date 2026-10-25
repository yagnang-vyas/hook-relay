import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createReadiness } from '../../src/db.js';
import { applyMigrations } from '../../src/migrate.js';
import { Metrics } from '../../src/metrics.js';
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
