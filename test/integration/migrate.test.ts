import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MigrationError } from '../../src/migrate.js';

const url = process.env['DATABASE_URL'] ?? '';
const schema = `m_${Math.random().toString(16).slice(2, 10)}`;
let admin: pg.Pool;
let pool: pg.Pool;
let work: string;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${schema}` });
  work = mkdtempSync(join(tmpdir(), 'hr-migrations-'));
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
});

function writeMigration(dir: string, name: string, sql: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'migration.sql'), sql);
}

describe('applyMigrations', () => {
  it('applies the real migrations, records them, and is idempotent', async () => {
    const first = await applyMigrations(pool, 'prisma/migrations');
    expect(first.length).toBeGreaterThan(0);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['events', 'deliveries', 'attempts', '_prisma_migrations']),
    );
    expect(await applyMigrations(pool, 'prisma/migrations')).toEqual([]);
  });

  it('serialises concurrent runners so each migration is applied once', async () => {
    const dir = join(work, 'concurrent');
    writeMigration(dir, '001_a', 'CREATE TABLE concurrent_a (id int);');
    writeMigration(dir, '002_b', 'CREATE TABLE concurrent_b (id int);');
    const results = await Promise.all(Array.from({ length: 5 }, () => applyMigrations(pool, dir)));
    const total = results.flat();
    expect(total.sort()).toEqual(['001_a', '002_b']);
  });

  it('applies new migrations in lexical order after earlier ones', async () => {
    const dir = join(work, 'ordered');
    writeMigration(dir, '001_first', 'CREATE TABLE ordered_one (id int);');
    expect(await applyMigrations(pool, dir)).toEqual(['001_first']);
    writeMigration(dir, '003_third', 'CREATE TABLE ordered_three (id int);');
    writeMigration(dir, '002_second', 'CREATE TABLE ordered_two (id int);');
    expect(await applyMigrations(pool, dir)).toEqual(['002_second', '003_third']);
  });

  it('refuses to run when an applied migration was modified', async () => {
    const dir = join(work, 'modified');
    writeMigration(dir, '001_x', 'CREATE TABLE modified_x (id int);');
    await applyMigrations(pool, dir);
    writeMigration(dir, '001_x', 'CREATE TABLE modified_x (id int, extra int);');
    await expect(applyMigrations(pool, dir)).rejects.toThrow(MigrationError);
  });

  it('rolls back a failing migration completely and can be retried after a fix', async () => {
    const dir = join(work, 'failing');
    writeMigration(
      dir,
      '001_bad',
      'CREATE TABLE failing_ok (id int); SELECT * FROM does_not_exist;',
    );
    await expect(applyMigrations(pool, dir)).rejects.toThrow();
    const exists = await pool.query(`SELECT to_regclass('failing_ok') AS t`);
    expect((exists.rows[0] as { t: string | null }).t).toBeNull();
    const rows = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = '001_bad'`,
    );
    expect(rows.rowCount).toBe(0);

    writeMigration(dir, '001_bad', 'CREATE TABLE failing_ok (id int);');
    expect(await applyMigrations(pool, dir)).toEqual(['001_bad']);
  });

  it('refuses to proceed past an unresolved failed migration recorded by another tool', async () => {
    const dir = join(work, 'unresolved');
    writeMigration(dir, '001_u', 'CREATE TABLE unresolved_u (id int);');
    await pool.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('x-unresolved', 'abc', '001_u')`,
    );
    await expect(applyMigrations(pool, dir)).rejects.toThrow(/previously failed/);
    await pool.query(`DELETE FROM _prisma_migrations WHERE id = 'x-unresolved'`);
  });

  it('ignores rolled-back records', async () => {
    const dir = join(work, 'rolledback');
    writeMigration(dir, '001_r', 'CREATE TABLE rolledback_r (id int);');
    await pool.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, rolled_back_at) VALUES ('x-rb', 'abc', '001_r', now())`,
    );
    expect(await applyMigrations(pool, dir)).toEqual(['001_r']);
  });

  it('copes with the real migrations directory being copied elsewhere', async () => {
    const dir = join(work, 'copy');
    cpSync('prisma/migrations', dir, { recursive: true });
    const other = new pg.Pool({
      connectionString: url,
      max: 1,
      options: `-c search_path=${schema}_copy`,
    });
    await admin.query(`CREATE SCHEMA ${schema}_copy`);
    try {
      expect((await applyMigrations(other, dir)).length).toBeGreaterThan(0);
    } finally {
      await other.end();
      await admin.query(`DROP SCHEMA ${schema}_copy CASCADE`);
    }
  });
});
