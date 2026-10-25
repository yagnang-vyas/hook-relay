import type { Logger } from './logger.js';
import type { Db } from './prisma.js';
import { Prisma } from './generated/prisma/client.js';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;

/**
 * Deletes the stored bodies of events older than `retentionDays`, keeping all metadata. Events
 * that still have undelivered work are left alone so retention can never turn a pending delivery
 * into a failure. Works in batches and skips rows locked by other transactions, so it is safe to
 * run concurrently with ingestion, replay and other instances. Returns the number purged.
 */
export async function purgeExpiredBodies(
  db: Db,
  retentionDays: number,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  for (;;) {
    const purged = await db.$executeRaw(Prisma.sql`
      WITH batch AS (
        SELECT e.id FROM events e
        WHERE e.body_purged = false
          AND e.received_at < now() - make_interval(days => ${retentionDays}::int)
          AND NOT EXISTS (
            SELECT 1 FROM deliveries d
            WHERE d.event_id = e.id AND d.status IN ('pending', 'retrying', 'in_flight')
          )
        ORDER BY e.received_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE events SET body = NULL, body_purged = true
      FROM batch WHERE events.id = batch.id
    `);
    total += purged;
    if (purged < batchSize) return total;
  }
}

/** Runs {@link purgeExpiredBodies} once at start and then every hour. */
export class RetentionJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number,
    private readonly logger: Logger,
    private readonly intervalMs = RETENTION_INTERVAL_MS,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {}

  start(): void {
    this.schedule(0);
  }

  async runOnce(): Promise<number> {
    const purged = await purgeExpiredBodies(this.db, this.retentionDays, this.batchSize);
    if (purged > 0) this.logger.info({ purged }, 'purged expired event bodies');
    return purged;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .then(() => undefined)
        .catch((err: unknown) => {
          this.logger.error({ err }, 'retention run failed');
        })
        .finally(() => {
          this.schedule(this.intervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
