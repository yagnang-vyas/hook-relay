import request from 'supertest';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReadiness } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { Metrics } from '../../src/metrics.js';
import { githubSignature, hmacHex, timestampedSignature } from '../fixtures/sign.js';
import { TEST_SECRETS, captureLogger, testConfig } from '../helpers.js';
import { createTestApp, setupTestDb, type TestApp, type TestDb } from './harness.js';

let t: TestDb;
let ctx: TestApp;
const NOW_S = 1_800_000_000;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.teardown();
});
beforeEach(async () => {
  await t.reset();
  ctx = createTestApp(t, { now: () => NOW_S * 1000 });
});

function postGithub(
  body: string | Buffer,
  id: string | null = 'delivery-1',
  secret: string = TEST_SECRETS.github,
) {
  const req = request(ctx.app)
    .post('/hooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', githubSignature(secret, body));
  if (id !== null) req.set('X-GitHub-Delivery', id);
  return req.send(body);
}

describe('POST /hooks/:sourceId', () => {
  it('accepts a valid webhook and persists the event with one pending delivery', async () => {
    const body = JSON.stringify({ action: 'opened', number: 7 });
    const res = await postGithub(body);

    expect(res.status).toBe(202);
    const json = res.body as { status: string; eventId: string };
    expect(json.status).toBe('accepted');

    const event = await t.db.event.findUniqueOrThrow({ where: { id: json.eventId } });
    expect(event).toMatchObject({
      sourceId: 'github',
      deliveryId: 'delivery-1',
      generatedId: false,
      contentType: 'application/json',
      bodySize: Buffer.byteLength(body),
      bodyPurged: false,
    });
    expect(Buffer.from(event.body ?? []).toString('utf8')).toBe(body);

    const deliveries = await t.db.delivery.findMany({ where: { eventId: event.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ targetId: 'orders', status: 'pending', attempts: 0 });
    expect(ctx.metrics.get('events_accepted_total', { source: 'github' })).toBe(1);
  });

  it('stores only allow-listed headers and never the signature or credentials', async () => {
    const body = '{"a":1}';
    await postGithub(body)
      .set('Authorization', 'Bearer should-not-be-stored')
      .set('Cookie', 'session=nope')
      .set('X-GitHub-Event', 'push')
      .expect(202);
    const event = await t.db.event.findFirstOrThrow();
    const headers = event.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-1',
    });
    const stored = JSON.stringify(headers).toLowerCase();
    expect(stored).not.toContain('sha256=');
    expect(stored).not.toContain('should-not-be-stored');
    expect(stored).not.toContain('session=nope');
    expect(Object.keys(headers)).not.toContain('x-hub-signature-256');
  });

  it('creates one delivery per configured target', async () => {
    const body = '{"type":"payment.succeeded"}';
    const res = await request(ctx.app)
      .post('/hooks/payments')
      .set('X-Event-Id', 'evt_1')
      .set('X-Signature', timestampedSignature(TEST_SECRETS.paymentsOld, body, NOW_S))
      .send(body);
    expect(res.status).toBe(202);
    const deliveries = await t.db.delivery.findMany({ orderBy: { targetId: 'asc' } });
    expect(deliveries.map((d) => d.targetId)).toEqual(['billing', 'orders']);
  });

  it('preserves the exact bytes of a non-UTF-8 body', async () => {
    const body = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x7f]);
    const res = await request(ctx.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/octet-stream')
      .set('X-GitHub-Delivery', 'bin-1')
      .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
      .send(body);
    expect(res.status).toBe(202);
    const event = await t.db.event.findFirstOrThrow();
    expect(Buffer.from(event.body ?? []).equals(body)).toBe(true);
  });

  it('verifies against the raw bytes, not a re-serialised form', async () => {
    const body = '{ "spaced":   "out" }';
    expect((await postGithub(body)).status).toBe(202);
    const sig = githubSignature(TEST_SECRETS.github, JSON.stringify(JSON.parse(body)));
    const res = await request(ctx.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', 'delivery-2')
      .set('X-Hub-Signature-256', sig)
      .send(body);
    expect(res.status).toBe(401);
  });

  it('accepts an empty body when it is correctly signed', async () => {
    const res = await request(ctx.app)
      .post('/hooks/plain')
      .set('X-Sig', hmacHex(TEST_SECRETS.github, ''))
      .send();
    expect(res.status).toBe(202);
    const event = await t.db.event.findFirstOrThrow();
    expect(event).toMatchObject({ bodySize: 0, generatedId: true });
  });

  it('generates and flags a delivery ID when the header is absent', async () => {
    const res = await postGithub('{}', null);
    expect(res.status).toBe(202);
    const event = await t.db.event.findFirstOrThrow();
    expect(event.generatedId).toBe(true);
    expect(event.deliveryId).toMatch(/^gen_[0-9a-f-]{36}$/);
  });

  it('gives two requests without delivery IDs separate events', async () => {
    await postGithub('{}', null).expect(202);
    await postGithub('{}', null).expect(202);
    expect(await t.db.event.count()).toBe(2);
  });

  it('rejects a malformed delivery ID after verifying the signature', async () => {
    const res = await postGithub('{}', 'has spaces');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_delivery_id');
    expect(await t.db.event.count()).toBe(0);
  });

  it('rejects content-encoded bodies instead of verifying a decompressed form', async () => {
    const body = Buffer.from('{}');
    const res = await request(ctx.app)
      .post('/hooks/github')
      .set('Content-Encoding', 'gzip')
      .set('X-GitHub-Delivery', 'gz-1')
      .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
      .send(body);
    expect(res.status).toBe(415);
    expect(await t.db.event.count()).toBe(0);
  });
});

describe('duplicate detection', () => {
  it('answers 200 duplicate for a repeated delivery ID and creates nothing new', async () => {
    const first = await postGithub('{"n":1}', 'dup-1');
    expect(first.status).toBe(202);
    const second = await postGithub('{"n":1}', 'dup-1');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'duplicate' });
    expect(await t.db.event.count()).toBe(1);
    expect(await t.db.delivery.count()).toBe(1);
    expect(ctx.metrics.get('events_duplicate_total', { source: 'github' })).toBe(1);
  });

  it('keeps the same delivery ID distinct across sources', async () => {
    const body = '{}';
    await postGithub(body, 'shared-id').expect(202);
    await request(ctx.app)
      .post('/hooks/payments')
      .set('X-Event-Id', 'shared-id')
      .set('X-Signature', timestampedSignature(TEST_SECRETS.paymentsNew, body, NOW_S))
      .send(body)
      .expect(202);
    expect(await t.db.event.count()).toBe(2);
  });

  it('lets exactly one of many concurrent identical deliveries through', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => postGithub('{"race":true}', 'race-1')),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(11);
    expect(await t.db.event.count()).toBe(1);
    expect(await t.db.delivery.count()).toBe(1);
  });
});

describe('rejections', () => {
  it('returns 404 for an unknown source', async () => {
    const res = await request(ctx.app).post('/hooks/nope').send('{}');
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('unknown_source');
  });

  it('returns 401 for a bad signature, persists nothing and counts it', async () => {
    const res = await postGithub('{"x":1}', 'bad-1', 'wrong-secret');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'invalid_signature',
        message: 'Unauthorized',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(await t.db.event.count()).toBe(0);
    expect(await t.db.delivery.count()).toBe(0);
    expect(
      ctx.metrics.get('invalid_signatures_total', {
        source: 'github',
        reason: 'signature_mismatch',
      }),
    ).toBe(1);
  });

  it('returns 401 for a missing or malformed signature header', async () => {
    const missing = await request(ctx.app).post('/hooks/github').send('{}');
    expect(missing.status).toBe(401);
    const malformed = await request(ctx.app)
      .post('/hooks/github')
      .set('X-Hub-Signature-256', 'garbage')
      .send('{}');
    expect(malformed.status).toBe(401);
    expect(
      ctx.metrics.get('invalid_signatures_total', { source: 'github', reason: 'missing_header' }),
    ).toBe(1);
    expect(
      ctx.metrics.get('invalid_signatures_total', { source: 'github', reason: 'malformed_header' }),
    ).toBe(1);
  });

  it('returns 401 for a replayed timestamped signature outside the tolerance', async () => {
    const body = '{}';
    const res = await request(ctx.app)
      .post('/hooks/payments')
      .set('X-Event-Id', 'old-1')
      .set('X-Signature', timestampedSignature(TEST_SECRETS.paymentsNew, body, NOW_S - 3600))
      .send(body);
    expect(res.status).toBe(401);
    expect(await t.db.event.count()).toBe(0);
  });

  it('returns 413 for a body over the limit and persists nothing', async () => {
    ctx = createTestApp(t, { maxBodyBytes: 1024 });
    const body = 'a'.repeat(2048);
    const res = await postGithub(body);
    expect(res.status).toBe(413);
    expect((res.body as { error: { code: string } }).error.code).toBe('payload_too_large');
    expect(await t.db.event.count()).toBe(0);
  });

  it('accepts a body of exactly the limit', async () => {
    ctx = createTestApp(t, { maxBodyBytes: 1024 });
    const body = 'a'.repeat(1024);
    expect((await postGithub(body)).status).toBe(202);
  });

  it('does not log the signature, secret or body when rejecting', async () => {
    const body = '{"card":"4111-test-body-marker"}';
    const res = await postGithub(body, 'log-1', 'wrong-secret').set(
      'Authorization',
      'Bearer auth-marker',
    );
    expect(res.status).toBe(401);
    const out = ctx.logs.output();
    expect(out).toContain('rejected webhook with invalid signature');
    expect(out).not.toContain('4111-test-body-marker');
    expect(out).not.toContain('wrong-secret');
    expect(out).not.toContain(githubSignature('wrong-secret', body));
    expect(out).not.toContain('auth-marker');
  });
});

describe('transaction atomicity', () => {
  it('leaves no event behind when creating deliveries fails after the event insert', async () => {
    const failing = t.db.$extends({
      query: {
        delivery: {
          createMany() {
            return Promise.reject(new Error('simulated failure after event insert'));
          },
        },
      },
    });
    ctx = createTestApp(t, { db: failing as unknown as typeof t.db });

    const res = await postGithub('{"atomic":true}', 'atomic-1');
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal_error');

    expect(await t.db.event.count()).toBe(0);
    expect(await t.db.delivery.count()).toBe(0);

    // The delivery ID is not burned: the same webhook succeeds once storage recovers.
    ctx = createTestApp(t);
    expect((await postGithub('{"atomic":true}', 'atomic-1')).status).toBe(202);
  });
});

describe('GET /readyz', () => {
  it('is ready when the database answers and migrations are applied', async () => {
    const res = await request(ctx.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('reports pending migrations', async () => {
    await t.pool.query('UPDATE _prisma_migrations SET finished_at = NULL');
    try {
      const res = await request(ctx.app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable', reason: 'migrations_pending' });
    } finally {
      await t.pool.query('UPDATE _prisma_migrations SET finished_at = now()');
    }
  });

  it('reports pending migrations when the migrations table does not exist', async () => {
    const otherSchema = `${t.schema}_empty`;
    await t.pool.query(`CREATE SCHEMA ${otherSchema}`);
    const pool = new pg.Pool({
      connectionString: t.databaseUrl,
      max: 1,
      options: `-c search_path=${otherSchema}`,
    });
    try {
      const result = await createReadiness(pool, 'prisma/migrations')();
      expect(result).toEqual({ ok: false, reason: 'migrations_pending' });
    } finally {
      await pool.end();
      await t.pool.query(`DROP SCHEMA ${otherSchema} CASCADE`);
    }
  });

  it('reports pending migrations when the migrations directory is unreadable', async () => {
    const result = await createReadiness(t.pool, 'does/not/exist')();
    expect(result).toEqual({ ok: false, reason: 'migrations_pending' });
  });

  it('is unavailable when the database is down', async () => {
    const dead = new pg.Pool({
      connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/none',
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const config = testConfig();
    const app = createApp({
      config,
      logger: captureLogger().logger,
      metrics: new Metrics(),
      readiness: createReadiness(dead, config.env.migrationsDir),
      db: t.db,
    });
    try {
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable', reason: 'database_unreachable' });
    } finally {
      await dead.end();
    }
  });
});
