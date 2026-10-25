import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../prisma.js';

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  targetId: string;
  /** Lifetime attempt number of the attempt that was just claimed. */
  attempts: number;
  attemptsBase: number;
}

interface ClaimRow {
  id: string;
  event_id: string;
  target_id: string;
  attempts: number;
  attempts_base: number;
}

/**
 * Atomically claims up to `limit` due deliveries. `FOR UPDATE SKIP LOCKED` lets concurrent
 * workers take disjoint rows without blocking each other, and because the claim is a single
 * statement the in-flight state and lease are committed before any HTTP call is made.
 * The attempt counter is incremented here, so a worker that crashes mid-request still consumes
 * an attempt and a poison delivery eventually dies.
 */
export async function claimDue(
  db: Db,
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedDelivery[]> {
  const rows = await db.$queryRaw<ClaimRow[]>(Prisma.sql`
    WITH due AS (
      SELECT id FROM deliveries
      WHERE status IN ('pending', 'retrying') AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deliveries d
    SET status = 'in_flight',
        lease_until = now() + make_interval(secs => ${leaseSeconds}::double precision),
        attempts = d.attempts + 1,
        updated_at = now()
    FROM due
    WHERE d.id = due.id
    RETURNING d.id, d.event_id, d.target_id, d.attempts, d.attempts_base
  `);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    targetId: r.target_id,
    attempts: r.attempts,
    attemptsBase: r.attempts_base,
  }));
}

export type DeadReason = 'permanent_status' | 'max_attempts' | 'unknown_target' | 'body_purged';

export type Completion =
  { kind: 'delivered' } | { kind: 'retry'; delayMs: number } | { kind: 'dead'; reason: DeadReason };

export interface AttemptRecord {
  startedAt: Date;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
}

/**
 * Records an attempt and applies its outcome to the delivery in one transaction.
 *
 * The update is fenced on `status = 'in_flight' AND attempts = <claimed attempt>`: if this
 * worker's lease expired and the delivery was recovered (and possibly claimed again) in the
 * meantime, the update matches nothing and the stale result is discarded. The function returns
 * whether the outcome was applied.
 */
export async function completeAttempt(
  db: Db,
  claim: ClaimedDelivery,
  attempt: AttemptRecord,
  completion: Completion,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.attempt.createMany({
      data: [
        {
          deliveryId: claim.id,
          attemptNumber: claim.attempts,
          startedAt: attempt.startedAt,
          durationMs: attempt.durationMs,
          statusCode: attempt.statusCode,
          error: attempt.error,
        },
      ],
      skipDuplicates: true,
    });

    const status =
      completion.kind === 'delivered'
        ? 'delivered'
        : completion.kind === 'retry'
          ? 'retrying'
          : 'dead';
    const deadReason = completion.kind === 'dead' ? completion.reason : null;
    const delaySeconds = completion.kind === 'retry' ? completion.delayMs / 1000 : 0;

    const updated = await tx.$executeRaw`
      UPDATE deliveries
      SET status = ${status}::delivery_status,
          lease_until = NULL,
          last_status = ${attempt.statusCode},
          last_error = ${attempt.error},
          dead_reason = ${deadReason},
          delivered_at = CASE WHEN ${status} = 'delivered' THEN now() ELSE delivered_at END,
          next_attempt_at = CASE WHEN ${status} = 'retrying'
                                 THEN now() + make_interval(secs => ${delaySeconds}::double precision)
                                 ELSE next_attempt_at END,
          updated_at = now()
      WHERE id = ${claim.id}::uuid AND status = 'in_flight' AND attempts = ${claim.attempts}
    `;
    return updated === 1;
  });
}

export async function listDeadDeliveries(db: Db, limit: number, after: string | undefined) {
  const rows = await db.delivery.findMany({
    where: { status: 'dead', ...(after !== undefined ? { id: { lt: after } } : {}) },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      eventId: true,
      targetId: true,
      attempts: true,
      lastStatus: true,
      lastError: true,
      deadReason: true,
      createdAt: true,
      updatedAt: true,
      event: { select: { sourceId: true, deliveryId: true, bodyPurged: true } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page, nextAfter: rows.length > limit && last !== undefined ? last.id : null };
}

export type RetryResult =
  | { status: 'not_found' }
  | { status: 'not_dead'; current: string }
  | { status: 'body_purged' }
  | { status: 'requeued' };

/**
 * Moves a dead delivery back to `pending` with a fresh retry budget (`attempts_base` catches up
 * with `attempts`, so attempt numbering and history continue). The event row is locked
 * `FOR SHARE` so the body cannot be purged while the delivery is being requeued.
 */
export async function retryDeadDelivery(db: Db, id: string): Promise<RetryResult> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; has_body: boolean }[]>`
      SELECT d.status::text AS status, e.body IS NOT NULL AS has_body
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.id = ${id}::uuid
      FOR SHARE OF e FOR UPDATE OF d
    `;
    const row = rows[0];
    if (row === undefined) return { status: 'not_found' } as const;
    if (row.status !== 'dead') return { status: 'not_dead', current: row.status } as const;
    if (!row.has_body) return { status: 'body_purged' } as const;
    await tx.$executeRaw`
      UPDATE deliveries
      SET status = 'pending', attempts_base = attempts, next_attempt_at = now(),
          lease_until = NULL, dead_reason = NULL, updated_at = now()
      WHERE id = ${id}::uuid
    `;
    return { status: 'requeued' } as const;
  });
}
