import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RetentionJob, purgeExpiredBodies } from '../../src/retention.js';
import { captureLogger } from '../helpers.js';
import { makeDue, seedEvent, setupTestDb, type TestDb } from './harness.js';

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.teardown();
});
beforeEach(async () => {
  await t.reset();
});

const age = (eventId: string, days: number) =>
  t.pool.query(`UPDATE events SET received_at = now() - make_interval(days => $2) WHERE id = $1`, [
    eventId,
    days,
  ]);
const settle = (eventId: string, status: 'delivered' | 'dead') =>
  t.pool.query(`UPDATE deliveries SET status = $2::delivery_status WHERE event_id = $1`, [
    eventId,
    status,
  ]);

describe('purgeExpiredBodies', () => {
  it('deletes old bodies but keeps all metadata, deliveries and attempts', async () => {
    const eventId = await seedEvent(t.db, { body: 'OLD-PAYLOAD', deliveryId: 'old' });
    await t.db.attempt.create({
      data: {
        deliveryId: (await t.db.delivery.findFirstOrThrow()).id,
        attemptNumber: 1,
        durationMs: 5,
        statusCode: 200,
      },
    });
    await settle(eventId, 'delivered');
    await age(eventId, 30);

    expect(await purgeExpiredBodies(t.db, 14)).toBe(1);

    const event = await t.db.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event).toMatchObject({
      body: null,
      bodyPurged: true,
      bodySize: 11,
      deliveryId: 'old',
      sourceId: 'github',
    });
    expect(await t.db.delivery.count()).toBe(1);
    expect(await t.db.attempt.count()).toBe(1);
    expect(await purgeExpiredBodies(t.db, 14)).toBe(0);
  });

  it('keeps bodies that are within the retention window', async () => {
    const eventId = await seedEvent(t.db);
    await settle(eventId, 'delivered');
    await age(eventId, 13);
    expect(await purgeExpiredBodies(t.db, 14)).toBe(0);
    expect((await t.db.event.findUniqueOrThrow({ where: { id: eventId } })).body).not.toBeNull();
  });

  it.each(['pending', 'retrying', 'in_flight'] as const)(
    'never purges an event that still has a %s delivery',
    async (status) => {
      const eventId = await seedEvent(t.db);
      await t.pool.query(`UPDATE deliveries SET status = $1::delivery_status`, [status]);
      await age(eventId, 365);
      expect(await purgeExpiredBodies(t.db, 14)).toBe(0);
      await settle(eventId, 'dead');
      expect(await purgeExpiredBodies(t.db, 14)).toBe(1);
    },
  );

  it('purges events that have no deliveries at all', async () => {
    const eventId = await seedEvent(t.db);
    await t.pool.query('DELETE FROM deliveries');
    await age(eventId, 30);
    expect(await purgeExpiredBodies(t.db, 14)).toBe(1);
  });

  it('works through large backlogs in batches', async () => {
    for (let i = 0; i < 7; i++) {
      const id = await seedEvent(t.db, { deliveryId: `b-${i}` });
      await settle(id, 'delivered');
      await age(id, 40);
    }
    expect(await purgeExpiredBodies(t.db, 14, 3)).toBe(7);
    expect(await t.db.event.count({ where: { bodyPurged: true } })).toBe(7);
  });

  it('skips events locked by a concurrent replay', async () => {
    const eventId = await seedEvent(t.db);
    await settle(eventId, 'delivered');
    await age(eventId, 30);
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM events WHERE id = $1 FOR SHARE', [eventId]);
      expect(await purgeExpiredBodies(t.db, 14)).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await purgeExpiredBodies(t.db, 14)).toBe(1);
  });

  it('makes a purged event non-deliverable rather than losing the delivery silently', async () => {
    const eventId = await seedEvent(t.db);
    await settle(eventId, 'dead');
    await age(eventId, 30);
    await purgeExpiredBodies(t.db, 14);
    await t.pool.query(`UPDATE deliveries SET status = 'pending'`);
    await makeDue(t.pool);
    // A worker would dead-letter this with reason body_purged (covered in worker tests).
    expect((await t.db.event.findUniqueOrThrow({ where: { id: eventId } })).bodyPurged).toBe(true);
  });
});

describe('RetentionJob', () => {
  it('runs on start, repeats on its interval, and stops cleanly', async () => {
    const { logger, output } = captureLogger();
    const first = await seedEvent(t.db, { deliveryId: 'j1' });
    await settle(first, 'delivered');
    await age(first, 30);

    const job = new RetentionJob(t.db, 14, logger, 50);
    job.start();
    await waitFor(
      async () => (await t.db.event.findUniqueOrThrow({ where: { id: first } })).bodyPurged,
    );

    const second = await seedEvent(t.db, { deliveryId: 'j2' });
    await settle(second, 'delivered');
    await age(second, 30);
    await waitFor(
      async () => (await t.db.event.findUniqueOrThrow({ where: { id: second } })).bodyPurged,
    );

    await job.stop();
    expect(output()).toContain('purged expired event bodies');
  });

  it('logs a failure and keeps its schedule', async () => {
    const { logger, output } = captureLogger();
    let calls = 0;
    const flaky = t.db.$extends({
      query: {
        $executeRaw({ args, query }) {
          if (calls++ === 0) return Promise.reject(new Error('simulated outage'));
          return query(args);
        },
      },
    });
    const job = new RetentionJob(flaky as unknown as typeof t.db, 14, logger, 30);
    job.start();
    await waitFor(() => calls >= 2);
    await job.stop();
    expect(output()).toContain('retention run failed');
  });

  it('does not run after stop and tolerates stop before start', async () => {
    const { logger } = captureLogger();
    const job = new RetentionJob(t.db, 14, logger, 10);
    await job.stop();
    job.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(await t.db.event.count()).toBe(0);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}
