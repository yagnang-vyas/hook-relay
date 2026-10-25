import type { TargetConfig } from '../config.js';
import type { Db } from '../prisma.js';

export const LEASE_EXPIRED_ERROR =
  'lease expired before the attempt completed (worker stopped or stalled)';

/**
 * Returns deliveries that are stuck `in_flight` past their lease (a crashed or stalled worker) to
 * the queue. The stuck attempt counts against the retry budget; a delivery whose budget is spent
 * goes straight to `dead`. Deliveries for targets that are no longer configured also go to `dead`.
 * Returns the number of deliveries recovered.
 */
const sum = (rows: { n: number }[]): number => rows.reduce((total, row) => total + row.n, 0);

export async function recoverExpiredLeases(
  db: Db,
  targets: ReadonlyMap<string, TargetConfig>,
): Promise<number> {
  let recovered = 0;
  for (const target of targets.values()) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      WITH expired AS (
        UPDATE deliveries
        SET status = CASE WHEN attempts - attempts_base >= ${target.maxAttempts}
                          THEN 'dead'::delivery_status ELSE 'retrying'::delivery_status END,
            dead_reason = CASE WHEN attempts - attempts_base >= ${target.maxAttempts}
                               THEN 'max_attempts' ELSE dead_reason END,
            last_error = ${LEASE_EXPIRED_ERROR}::text,
            next_attempt_at = now(),
            lease_until = NULL,
            updated_at = now()
        WHERE status = 'in_flight' AND lease_until < now() AND target_id = ${target.id}
        RETURNING id, attempts
      ), logged AS (
        INSERT INTO attempts (id, delivery_id, attempt_number, started_at, duration_ms, error)
        SELECT gen_random_uuid(), id, attempts, now(), 0, ${LEASE_EXPIRED_ERROR}::text FROM expired
        ON CONFLICT (delivery_id, attempt_number) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM expired
    `;
    recovered += sum(rows);
  }
  const known = [...targets.keys()];
  const orphans = await db.$queryRaw<{ n: number }[]>`
    WITH orphaned AS (
      UPDATE deliveries
      SET status = 'dead', dead_reason = 'unknown_target', lease_until = NULL, updated_at = now(),
          last_error = 'target is no longer configured'
      WHERE status = 'in_flight' AND lease_until < now() AND NOT (target_id = ANY(${known}::text[]))
      RETURNING id
    )
    SELECT count(*)::int AS n FROM orphaned
  `;
  recovered += sum(orphans);
  return recovered;
}
