import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recoverExpiredLeases, LEASE_EXPIRED_ERROR } from '../../src/delivery/lease.js';
import { claimDue, completeAttempt } from '../../src/store/deliveries.js';
import { FakeTarget } from '../fixtures/fake-target.js';
import { hmacHex } from '../fixtures/sign.js';
import { TEST_SECRETS } from '../helpers.js';
import {
  createTestWorker,
  makeDue,
  seedEvent,
  setupTestDb,
  type TestDb,
  type WorkerContext,
} from './harness.js';

let t: TestDb;
const target = new FakeTarget();
const contexts: WorkerContext[] = [];

beforeAll(async () => {
  t = await setupTestDb();
  await target.start();
});
afterAll(async () => {
  await target.stop();
  await t.teardown();
});
beforeEach(async () => {
  await t.reset();
  target.reset();
  target.respondWithSequence([200]);
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.forwarder.close();
});

function worker(options: Parameters<typeof createTestWorker>[1] = {}): WorkerContext {
  const ctx = createTestWorker(t, { ordersUrl: `${target.url}/hook`, ...options });
  contexts.push(ctx);
  return ctx;
}

const delivery = async () => t.db.delivery.findFirstOrThrow({ include: { attemptLog: true } });

describe('delivery', () => {
  it('forwards the stored event and marks the delivery delivered', async () => {
    const eventId = await seedEvent(t.db, { body: '{"order":42}' });
    const { worker: w, metrics } = worker();

    expect(await w.runOnce()).toBe(1);

    const d = await delivery();
    expect(d).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatus: 200,
      lastError: null,
      leaseUntil: null,
    });
    expect(d.deliveredAt).toBeInstanceOf(Date);
    expect(d.attemptLog).toHaveLength(1);
    expect(d.attemptLog[0]).toMatchObject({ attemptNumber: 1, statusCode: 200, error: null });

    const [seen] = target.requests;
    expect(seen?.body.toString()).toBe('{"order":42}');
    expect(seen?.headers['x-hookrelay-event-id']).toBe(eventId);
    expect(seen?.headers['x-hookrelay-delivery-id']).toBe(d.id);
    expect(seen?.headers['x-hookrelay-attempt']).toBe('1');
    expect(seen?.headers['x-hookrelay-signature']).toBe(
      `sha256=${hmacHex(TEST_SECRETS.relay, '{"order":42}')}`,
    );
    expect(metrics.get('delivery_attempts_total', { target: 'orders', result: 'delivered' })).toBe(
      1,
    );
  });

  it('does nothing when no delivery is due', async () => {
    const { worker: w } = worker();
    expect(await w.runOnce()).toBe(0);
    await seedEvent(t.db);
    await t.pool.query(`UPDATE deliveries SET next_attempt_at = now() + interval '1 hour'`);
    expect(await w.runOnce()).toBe(0);
    expect(target.requests).toHaveLength(0);
  });

  it('fans out to every target of an event', async () => {
    const billing = await new FakeTarget().start();
    try {
      await seedEvent(t.db, { sourceId: 'payments', targetIds: ['billing', 'orders'] });
      const { worker: w } = worker({ billingUrl: `${billing.url}/billing` });
      expect(await w.runOnce()).toBe(2);
      expect(billing.requests).toHaveLength(1);
      expect(target.requests).toHaveLength(1);
      expect((await t.db.delivery.findMany()).every((d) => d.status === 'delivered')).toBe(true);
    } finally {
      await billing.stop();
    }
  });

  it('delivers in due order and respects the batch size', async () => {
    for (let i = 0; i < 5; i++) await seedEvent(t.db, { body: `{"n":${i}}` });
    const { worker: w } = worker({ workerBatchSize: 2 });
    expect(await w.runOnce()).toBe(2);
    expect(await w.runOnce()).toBe(2);
    expect(await w.runOnce()).toBe(1);
    expect(await w.runOnce()).toBe(0);
    expect(target.requests).toHaveLength(5);
  });
});

describe('retries', () => {
  it('retries a 500 with backoff and then succeeds', async () => {
    await seedEvent(t.db);
    target.respondWithSequence([500, 200]);
    const { worker: w, metrics } = worker({
      backoff: { baseMs: 60_000, maxMs: 60_000 },
      random: () => 0.5,
    });

    await w.runOnce();
    let d = await delivery();
    expect(d).toMatchObject({ status: 'retrying', attempts: 1, lastStatus: 500, leaseUntil: null });
    expect(d.lastError).toBe('target responded with HTTP 500');
    // Jitter pinned at 0.5 of a 60s ceiling: about 30s from now, not immediately due.
    const wait = d.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThanOrEqual(31_000);
    expect(await w.runOnce()).toBe(0);

    await makeDue(t.pool);
    await w.runOnce();
    d = await delivery();
    expect(d).toMatchObject({ status: 'delivered', attempts: 2, lastStatus: 200 });
    expect(d.attemptLog.map((a) => [a.attemptNumber, a.statusCode]).sort()).toEqual([
      [1, 500],
      [2, 200],
    ]);
    expect(target.requests.map((r) => r.headers['x-hookrelay-attempt'])).toEqual(['1', '2']);
    expect(metrics.get('delivery_attempts_total', { target: 'orders', result: 'retry' })).toBe(1);
  });

  it('goes dead after maxAttempts failures', async () => {
    await seedEvent(t.db);
    target.respondWithSequence([503]);
    const { worker: w } = worker({ maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await makeDue(t.pool);
      await w.runOnce();
    }
    const d = await delivery();
    expect(d).toMatchObject({
      status: 'dead',
      attempts: 3,
      deadReason: 'max_attempts',
      lastStatus: 503,
    });
    await makeDue(t.pool);
    expect(await w.runOnce()).toBe(0);
    expect(target.requests).toHaveLength(3);
  });

  it('treats 408 and 429 as retryable', async () => {
    await seedEvent(t.db);
    target.respondWithSequence([429, 408, 200]);
    const { worker: w } = worker({ maxAttempts: 5 });
    for (let i = 0; i < 3; i++) {
      await makeDue(t.pool);
      await w.runOnce();
    }
    expect(await delivery()).toMatchObject({ status: 'delivered', attempts: 3 });
  });

  it.each([400, 401, 404, 422])('dead-letters a permanent %i immediately', async (status) => {
    await seedEvent(t.db);
    target.respondWithSequence([status]);
    const { worker: w } = worker({ maxAttempts: 5 });
    await w.runOnce();
    expect(await delivery()).toMatchObject({
      status: 'dead',
      attempts: 1,
      deadReason: 'permanent_status',
      lastStatus: status,
    });
    await makeDue(t.pool);
    expect(await w.runOnce()).toBe(0);
  });

  it('retries after a timeout and records a payload-free error', async () => {
    await seedEvent(t.db);
    target.respondWith(() => new Promise(() => undefined));
    const { worker: w } = worker({ timeoutMs: 150 });
    await w.runOnce();
    expect(await delivery()).toMatchObject({
      status: 'retrying',
      lastStatus: null,
      lastError: 'request timed out',
    });
  });

  it('never stores the target response body', async () => {
    await seedEvent(t.db);
    target.respondWith((_req, res) => {
      res.statusCode = 500;
      res.end('SECRET-RESPONSE-MARKER');
    });
    const { worker: w } = worker();
    await w.runOnce();
    const dump = await t.pool.query<{ j: string }>(
      `SELECT row_to_json(d)::text AS j FROM deliveries d
       UNION ALL SELECT row_to_json(a)::text FROM attempts a`,
    );
    expect(dump.rows.length).toBeGreaterThan(1);
    expect(JSON.stringify(dump.rows)).not.toContain('SECRET-RESPONSE-MARKER');
  });

  it('does not follow redirects', async () => {
    const other = await new FakeTarget().start();
    try {
      await seedEvent(t.db);
      target.respondWith((_req, res) => {
        res.statusCode = 307;
        res.setHeader('location', `${other.url}/x`);
        res.end();
      });
      const { worker: w } = worker();
      await w.runOnce();
      expect(await delivery()).toMatchObject({ status: 'retrying', lastStatus: 307 });
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.stop();
    }
  });

  it('keeps retry numbering after the budget resets for a manual retry', async () => {
    await seedEvent(t.db);
    target.respondWithSequence([500, 500, 200]);
    const { worker: w } = worker({ maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      await makeDue(t.pool);
      await w.runOnce();
    }
    expect(await delivery()).toMatchObject({ status: 'dead', attempts: 2 });
    // What POST /api/deliveries/:id/retry does: fresh budget, history preserved.
    await t.pool.query(
      `UPDATE deliveries SET status = 'pending', attempts_base = attempts, next_attempt_at = now(), dead_reason = NULL`,
    );
    await w.runOnce();
    const d = await delivery();
    expect(d).toMatchObject({ status: 'delivered', attempts: 3, attemptsBase: 2 });
    expect(target.requests.at(-1)?.headers['x-hookrelay-attempt']).toBe('3');
  });
});

describe('guards', () => {
  it('blocks private targets that are not allow-listed and sends nothing', async () => {
    await seedEvent(t.db);
    const { worker: w } = worker({ blockPrivate: true });
    await w.runOnce();
    expect(target.requests).toHaveLength(0);
    const d = await delivery();
    expect(d.status).toBe('retrying');
    expect(d.lastError).toMatch(/^blocked: .*loopback/);
  });

  it('dead-letters deliveries whose event body has been purged', async () => {
    await seedEvent(t.db);
    await t.pool.query(`UPDATE events SET body = NULL, body_purged = true`);
    const { worker: w } = worker();
    await w.runOnce();
    expect(await delivery()).toMatchObject({ status: 'dead', deadReason: 'body_purged' });
    expect(target.requests).toHaveLength(0);
  });

  it('dead-letters deliveries for targets that are no longer configured', async () => {
    await seedEvent(t.db);
    await t.pool.query(`UPDATE deliveries SET target_id = 'removed-target'`);
    const { worker: w } = worker();
    await w.runOnce();
    expect(await delivery()).toMatchObject({ status: 'dead', deadReason: 'unknown_target' });
  });
});

describe('concurrency', () => {
  it('never delivers the same delivery twice across competing workers', async () => {
    const total = 60;
    for (let i = 0; i < total; i++) await seedEvent(t.db, { body: `{"n":${i}}` });
    const workers = Array.from({ length: 4 }, () => worker({ workerBatchSize: 7 }).worker);

    const drain = async (w: (typeof workers)[number]) => {
      let idle = 0;
      while (idle < 2) {
        idle = (await w.runOnce()) === 0 ? idle + 1 : 0;
      }
    };
    await Promise.all(workers.map(drain));

    const deliveries = await t.db.delivery.findMany();
    expect(deliveries).toHaveLength(total);
    expect(deliveries.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);

    // The target saw each delivery exactly once.
    const seen = target.requests.map((r) => r.headers['x-hookrelay-delivery-id']);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(await t.db.attempt.count()).toBe(total);
  });

  it('concurrent claims return disjoint sets', async () => {
    for (let i = 0; i < 30; i++) await seedEvent(t.db);
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimDue(t.db, 10, 60)));
    const ids = claims.flat().map((c) => c.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(claims.flat().every((c) => c.attempts === 1)).toBe(true);
  });

  it('claims set a lease, bump the attempt counter and commit before any request', async () => {
    await seedEvent(t.db);
    const [claim] = await claimDue(t.db, 5, 60);
    expect(claim).toMatchObject({ targetId: 'orders', attempts: 1, attemptsBase: 0 });
    const row = await t.db.delivery.findUniqueOrThrow({ where: { id: claim?.id ?? '' } });
    expect(row.status).toBe('in_flight');
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await claimDue(t.db, 5, 60)).toEqual([]);
  });
});

describe('lease recovery', () => {
  async function crashAfterClaim(): Promise<string> {
    await seedEvent(t.db);
    const [claim] = await claimDue(t.db, 1, 60);
    // The worker "dies" here: nothing is completed. Age the lease instead of waiting.
    await t.pool.query(`UPDATE deliveries SET lease_until = now() - interval '1 second'`);
    return claim?.id ?? '';
  }

  it('returns a stuck in-flight delivery to the queue and redelivers it', async () => {
    const id = await crashAfterClaim();
    const { worker: w, metrics, config } = worker();

    expect(await recoverExpiredLeases(t.db, config.relay.targets)).toBe(1);
    let d = await t.db.delivery.findUniqueOrThrow({ where: { id }, include: { attemptLog: true } });
    expect(d).toMatchObject({
      status: 'retrying',
      attempts: 1,
      leaseUntil: null,
      lastError: LEASE_EXPIRED_ERROR,
    });
    expect(d.attemptLog).toHaveLength(1);

    await w.runOnce();
    d = await t.db.delivery.findUniqueOrThrow({ where: { id }, include: { attemptLog: true } });
    expect(d).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(d.attemptLog.map((a) => a.attemptNumber).sort()).toEqual([1, 2]);
    expect(metrics.get('leases_recovered_total')).toBe(0);
  });

  it('is performed by the worker itself on each iteration', async () => {
    const id = await crashAfterClaim();
    const { worker: w, metrics } = worker();
    await w.runOnce();
    expect(await t.db.delivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'delivered',
      attempts: 2,
    });
    expect(metrics.get('leases_recovered_total')).toBe(1);
  });

  it('leaves unexpired leases alone', async () => {
    await seedEvent(t.db);
    await claimDue(t.db, 1, 60);
    const { config } = worker();
    expect(await recoverExpiredLeases(t.db, config.relay.targets)).toBe(0);
    expect((await delivery()).status).toBe('in_flight');
  });

  it('dead-letters a crashed delivery whose retry budget is spent', async () => {
    await crashAfterClaim();
    const { config } = worker({ maxAttempts: 1 });
    expect(await recoverExpiredLeases(t.db, config.relay.targets)).toBe(1);
    expect(await delivery()).toMatchObject({ status: 'dead', deadReason: 'max_attempts' });
  });

  it('dead-letters expired deliveries of targets that are no longer configured', async () => {
    await crashAfterClaim();
    await t.pool.query(`UPDATE deliveries SET target_id = 'removed-target'`);
    const { config } = worker();
    expect(await recoverExpiredLeases(t.db, config.relay.targets)).toBe(1);
    expect(await delivery()).toMatchObject({ status: 'dead', deadReason: 'unknown_target' });
  });

  it('discards the result of a worker that lost its lease', async () => {
    await seedEvent(t.db);
    const [stale] = await claimDue(t.db, 1, 60);
    if (stale === undefined) throw new Error('expected a claim');
    // Lease expires, the delivery is recovered and claimed again by another worker.
    await t.pool.query(`UPDATE deliveries SET lease_until = now() - interval '1 second'`);
    const { config } = worker();
    await recoverExpiredLeases(t.db, config.relay.targets);
    const [fresh] = await claimDue(t.db, 1, 60);
    expect(fresh?.attempts).toBe(2);

    // The first worker finally finishes: its outcome must not overwrite the newer attempt.
    const applied = await completeAttempt(
      t.db,
      stale,
      { startedAt: new Date(), durationMs: 5, statusCode: 200, error: null },
      { kind: 'delivered' },
    );
    expect(applied).toBe(false);
    expect((await delivery()).status).toBe('in_flight');

    const ok = await completeAttempt(
      t.db,
      fresh!,
      { startedAt: new Date(), durationMs: 5, statusCode: 200, error: null },
      { kind: 'delivered' },
    );
    expect(ok).toBe(true);
    expect((await delivery()).status).toBe('delivered');
  });
});

describe('worker loop', () => {
  it('drains a backlog larger than one batch without idling between batches', async () => {
    for (let i = 0; i < 5; i++) await seedEvent(t.db);
    const { worker: w } = worker({ workerBatchSize: 2 });
    w.start();
    await expectEventually(
      async () => (await t.db.delivery.count({ where: { status: 'delivered' } })) === 5,
    );
    await w.stop(1_000);
    expect(target.requests).toHaveLength(5);
  });

  it('throttles lease sweeps between iterations', async () => {
    await seedEvent(t.db);
    const { worker: w, metrics } = worker({ leaseSweepIntervalMs: 60_000 });
    await w.runOnce(); // first call sweeps (nothing to recover) and delivers
    await seedEvent(t.db);
    await claimDue(t.db, 1, 60);
    await t.pool.query(
      `UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE status = 'in_flight'`,
    );
    await w.runOnce(); // within the sweep interval: the stuck delivery is not recovered yet
    expect(metrics.get('leases_recovered_total')).toBe(0);
    expect(await t.db.delivery.count({ where: { status: 'in_flight' } })).toBe(1);
  });

  it('discards and reports a result when the lease was lost mid-request', async () => {
    await seedEvent(t.db);
    const { config } = worker();
    const slowForwarder = {
      forward: async () => {
        // While "our" request is in flight the lease expires and another worker claims the row.
        await t.pool.query(`UPDATE deliveries SET lease_until = now() - interval '1 second'`);
        await recoverExpiredLeases(t.db, config.relay.targets);
        await claimDue(t.db, 1, 60);
        return { kind: 'delivered' as const, statusCode: 200 };
      },
      close: () => Promise.resolve(),
    };
    const ctx = createTestWorker(t, { forwarder: slowForwarder });
    await ctx.worker.runOnce();
    expect(ctx.logs.output()).toContain('result discarded: lease was lost');
    expect(await delivery()).toMatchObject({ status: 'in_flight', attempts: 2 });
  });

  it('processes work in the background until stopped', async () => {
    const { worker: w } = worker();
    w.start();
    w.start(); // idempotent
    await seedEvent(t.db);
    await expectEventually(async () => (await delivery()).status === 'delivered');
    await w.stop(1_000);
    expect(target.requests).toHaveLength(1);
  });

  it('keeps running after an iteration fails', async () => {
    let failures = 0;
    const flaky = t.db.$extends({
      query: {
        $queryRaw({ args, query }) {
          if (failures++ === 0) return Promise.reject(new Error('simulated database outage'));
          return query(args);
        },
      },
    });
    await seedEvent(t.db);
    const ctx = createTestWorker(
      { db: flaky as unknown as typeof t.db },
      { ordersUrl: `${target.url}/hook` },
    );
    contexts.push(ctx);
    ctx.worker.start();
    await expectEventually(async () => (await delivery()).status === 'delivered');
    await ctx.worker.stop(1_000);
    expect(ctx.logs.output()).toContain('worker iteration failed');
    expect(failures).toBeGreaterThan(1);
  });

  it('waits for in-flight requests during the grace period', async () => {
    await seedEvent(t.db);
    target.respondWith(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      res.statusCode = 200;
      res.end('ok');
    });
    const { worker: w } = worker();
    w.start();
    await expectEventually(() => target.requests.length === 1);
    await w.stop(5_000);
    expect(await delivery()).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('aborts requests still running after the grace period and schedules a retry', async () => {
    await seedEvent(t.db);
    target.respondWith(() => new Promise(() => undefined));
    const { worker: w, logs } = worker({ timeoutMs: 30_000, leaseSeconds: 60 });
    w.start();
    await expectEventually(() => target.requests.length === 1);
    await w.stop(100);
    expect(await delivery()).toMatchObject({ status: 'retrying', lastError: 'request aborted' });
    expect(logs.output()).toContain('aborting in-flight deliveries');
  });

  it('stop resolves immediately when never started', async () => {
    const { worker: w } = worker();
    await w.stop(10);
  });
});

async function expectEventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}
