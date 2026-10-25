import { readdirSync } from 'node:fs';
import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring (for example during a database restart) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

export type ReadinessResult =
  { ok: true } | { ok: false; reason: 'database_unreachable' | 'migrations_pending' };

export type Readiness = () => Promise<ReadinessResult>;

function localMigrationNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Ready means: the database answers, and every migration shipped with this build
 * has been applied successfully.
 */
export function createReadiness(pool: pg.Pool, migrationsDir: string): Readiness {
  return async () => {
    let applied: Set<string>;
    try {
      await pool.query('SELECT 1');
    } catch {
      return { ok: false, reason: 'database_unreachable' };
    }
    try {
      const res = await pool.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      );
      applied = new Set(res.rows.map((r) => r.migration_name));
    } catch {
      return { ok: false, reason: 'migrations_pending' };
    }
    let expected: string[];
    try {
      expected = localMigrationNames(migrationsDir);
    } catch {
      return { ok: false, reason: 'migrations_pending' };
    }
    return expected.every((name) => applied.has(name))
      ? { ok: true }
      : { ok: false, reason: 'migrations_pending' };
  };
}
