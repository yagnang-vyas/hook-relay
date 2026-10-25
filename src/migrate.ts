import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

/** Arbitrary constant identifying HookRelay's migration lock among advisory locks. */
const MIGRATION_LOCK_ID = 727_101_001;

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
)`;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

interface LocalMigration {
  name: string;
  sql: string;
  checksum: string;
}

function readLocalMigrations(dir: string): LocalMigration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies the SQL migrations produced by `prisma migrate dev`, recording them in the same
 * `_prisma_migrations` table the Prisma CLI uses, so both tools can be used interchangeably.
 * Concurrent runs are serialised with an advisory lock; each migration runs in a transaction.
 *
 * This exists so that the production image only needs Node: the Prisma CLI's schema engine is
 * a native binary with its own system library requirements.
 */
export async function applyMigrations(pool: pg.Pool, dir: string): Promise<string[]> {
  const local = readLocalMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(CREATE_MIGRATIONS_TABLE);

    const rows = await client.query<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations');

    const history = new Map<string, (typeof rows.rows)[number]>();
    for (const row of rows.rows) {
      if (row.rolled_back_at !== null) continue;
      if (row.finished_at === null) {
        throw new MigrationError(
          `migration ${row.migration_name} previously failed and is unresolved; fix the database and resolve it with "prisma migrate resolve"`,
        );
      }
      history.set(row.migration_name, row);
    }

    for (const migration of local) {
      const done = history.get(migration.name);
      if (done !== undefined) {
        if (done.checksum !== migration.checksum) {
          throw new MigrationError(
            `migration ${migration.name} was modified after it was applied; create a new migration instead`,
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(
          'INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ($1, $2, $3)',
          [randomUUID(), migration.checksum, migration.name],
        );
        await client.query(migration.sql);
        await client.query(
          'UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE migration_name = $1 AND finished_at IS NULL',
          [migration.name],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(migration.name);
    }
    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
