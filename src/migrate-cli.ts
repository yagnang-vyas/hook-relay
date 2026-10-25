import { createPool } from './db.js';
import { applyMigrations } from './migrate.js';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  const dir = process.env['MIGRATIONS_DIR'] ?? 'prisma/migrations';
  const pool = createPool(databaseUrl, process.env['DATABASE_SCHEMA']);
  try {
    const applied = await applyMigrations(pool, dir);
    process.stdout.write(
      applied.length === 0
        ? 'No pending migrations\n'
        : `Applied migrations:\n${applied.map((n) => `  ${n}`).join('\n')}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
