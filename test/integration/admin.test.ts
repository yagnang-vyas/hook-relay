import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/routes/admin.js';
import { FakeTarget } from '../fixtures/fake-target.js';
import { TEST_SECRETS } from '../helpers.js';
import {
  createTestApp,
  createTestWorker,
  makeDue,
  seedEvent,
  setupTestDb,
  type TestApp,
  type TestDb,
} from './harness.js';

let t: TestDb;
let ctx: TestApp;
const target = new FakeTarget();
const auth = { Authorization: `Bearer ${TEST_SECRETS.admin}` };

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
  ctx = createTestApp(t, { ordersUrl: `${target.url}/hook` });
});

const get = (path: string) => request(ctx.app).get(path).set(auth);
const post = (path: string) => request(ctx.app).post(path).set(auth);

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe('authentication', () => {
  const endpoints: [string, string][] = [
    ['get', '/api/events'],
    ['get', `/api/events/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`],
    ['post', `/api/events/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/replay`],
    ['get', '/api/deliveries/dead'],
    ['post', `/api/deliveries/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/retry`],
    ['get', '/api/metrics'],
    ['get', '/api/does-not-exist'],
  ];

  it.each(endpoints)('%s %s requires a bearer token', async (method, path) => {
    const res = await (method === 'get' ? request(ctx.app).get(path) : request(ctx.app).post(path));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect((res.body as ErrorBody).error.code).toBe('unauthorized');
  });

  it.each([
    ['wrong key', 'Bearer not-the-admin-key-000000'],
    ['wrong scheme', `Basic ${TEST_SECRETS.admin}`],
    ['no scheme', TEST_SECRETS.admin],
    ['empty token', 'Bearer '],
    ['key with extra data', `Bearer ${TEST_SECRETS.admin} extra`],
    ['prefix of the key', `Bearer ${TEST_SECRETS.admin.slice(0, -1)}`],
    ['key with suffix', `Bearer ${TEST_SECRETS.admin}x`],
  ])('rejects %s', async (_name, header) => {
    const res = await request(ctx.app).get('/api/events').set('Authorization', header);
    expect(res.status).toBe(401);
  });

  it('accepts the key regardless of the scheme case', async () => {
    const res = await request(ctx.app)
      .get('/api/events')
      .set('Authorization', `bearer ${TEST_SECRETS.admin}`);
    expect(res.status).toBe(200);
  });

  it('does not require authentication for health checks or ingest', async () => {
    expect((await request(ctx.app).get('/healthz')).status).toBe(200);
    expect((await request(ctx.app).post('/hooks/github').send('{}')).status).toBe(401);
  });

  it('unknown /api routes return 404 once authenticated', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('not_found');
  });
});

describe('GET /api/events', () => {
  it('lists metadata only, newest first, with a delivery summary', async () => {
    const first = await seedEvent(t.db, { deliveryId: 'a', body: 'SECRET-BODY-1' });
    const second = await seedEvent(t.db, {
      deliveryId: 'b',
      sourceId: 'payments',
      targetIds: ['billing', 'orders'],
    });

    const res = await get('/api/events');
    expect(res.status).toBe(200);
    const page = res.body as Page<Record<string, unknown> & { id: string; deliveries: unknown[] }>;
    expect(page.nextCursor).toBeNull();
    expect(page.data.map((e) => e.id)).toEqual([second, first]);
    expect(page.data[0]).toMatchObject({
      sourceId: 'payments',
      deliveryId: 'b',
      bodySize: 13,
      bodyPurged: false,
    });
    expect(page.data[0]?.deliveries).toHaveLength(2);
    expect(page.data[1]?.deliveries).toEqual([
      expect.objectContaining({ targetId: 'orders', status: 'pending', attempts: 0 }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-BODY-1');
    expect(page.data[0]).not.toHaveProperty('body');
  });

  it('paginates with keyset cursors without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seedEvent(t.db, { deliveryId: `p-${i}` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/api/events?limit=3${cursor !== null ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      const page = res.body as Page<{ id: string }>;
      seen.push(...page.data.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
  });

  it('keeps a stable position when new events arrive between pages', async () => {
    for (let i = 0; i < 4; i++) await seedEvent(t.db);
    const first = (await get('/api/events?limit=2')).body as Page<{ id: string }>;
    await seedEvent(t.db);
    const second = (await get(`/api/events?limit=10&cursor=${first.nextCursor}`)).body as Page<{
      id: string;
    }>;
    expect(second.data).toHaveLength(2);
    expect(second.data.map((e) => e.id)).not.toEqual(
      expect.arrayContaining(first.data.map((e) => e.id)),
    );
  });

  it('filters by source and by delivery status', async () => {
    const gh = await seedEvent(t.db, { sourceId: 'github', deliveryId: 'g' });
    await seedEvent(t.db, { sourceId: 'payments', deliveryId: 'p', targetIds: ['billing'] });
    await t.pool.query(`UPDATE deliveries SET status = 'dead' WHERE event_id = $1`, [gh]);

    const bySource = (await get('/api/events?source=payments')).body as Page<{ sourceId: string }>;
    expect(bySource.data.map((e) => e.sourceId)).toEqual(['payments']);

    const byStatus = (await get('/api/events?status=dead')).body as Page<{ id: string }>;
    expect(byStatus.data.map((e) => e.id)).toEqual([gh]);

    const none = (await get('/api/events?source=github&status=pending')).body as Page<unknown>;
    expect(none.data).toEqual([]);
  });

  it.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['limit=1.5'],
    ['status=bogus'],
    ['unknown=1'],
    ['cursor=not-a-cursor'],
    [`cursor=${Buffer.from('not-a-uuid').toString('base64url')}`],
    [`cursor=${encodeCursor('00000000-0000-7000-8000-000000000000')}=`],
  ])('rejects invalid query %s with 400', async (query) => {
    const res = await get(`/api/events?${query}`);
    expect(res.status).toBe(400);
    expect(['validation_error', 'invalid_cursor']).toContain((res.body as ErrorBody).error.code);
  });

  it('round-trips cursors', () => {
    const id = '01234567-89ab-7def-8123-456789abcdef';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});

describe('GET /api/events/:id', () => {
  it('returns metadata, deliveries and attempts but no body by default', async () => {
    const eventId = await seedEvent(t.db, { body: 'PAYLOAD-123' });
    target.respondWithSequence([500, 200]);
    const { worker, forwarder } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await worker.runOnce();
    await makeDue(t.pool);
    await worker.runOnce();
    await forwarder.close();

    const res = await get(`/api/events/${eventId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      id: string;
      deliveries: {
        status: string;
        attempts: number;
        attemptHistory: { attemptNumber: number; statusCode: number }[];
      }[];
    };
    expect(body).toMatchObject({ id: eventId, sourceId: 'github', bodySize: 11 });
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(body.deliveries[0]?.attemptHistory.map((a) => [a.attemptNumber, a.statusCode])).toEqual([
      [1, 500],
      [2, 200],
    ]);
    expect(body).not.toHaveProperty('body');
    expect(body).not.toHaveProperty('bodyBase64');
    expect(JSON.stringify(res.body)).not.toContain('PAYLOAD-123');
    expect(JSON.stringify(res.body)).not.toContain(Buffer.from('PAYLOAD-123').toString('base64'));
  });

  it('returns the body as base64 only when asked', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const eventId = await seedEvent(t.db, { body: bytes });
    const res = await get(`/api/events/${eventId}?includeBody=true`);
    expect((res.body as { bodyBase64: string }).bodyBase64).toBe(bytes.toString('base64'));
    const explicitFalse = await get(`/api/events/${eventId}?includeBody=false`);
    expect(explicitFalse.body).not.toHaveProperty('bodyBase64');
  });

  it('reports a purged body as null', async () => {
    const eventId = await seedEvent(t.db);
    await t.pool.query(`UPDATE events SET body = NULL, body_purged = true`);
    const res = await get(`/api/events/${eventId}?includeBody=true`);
    expect(res.body).toMatchObject({ bodyBase64: null, bodyPurged: true });
  });

  it('returns 404 for unknown and malformed IDs and 400 for bad parameters', async () => {
    expect((await get('/api/events/00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await get('/api/events/not-a-uuid')).status).toBe(404);
    const eventId = await seedEvent(t.db);
    expect((await get(`/api/events/${eventId}?includeBody=maybe`)).status).toBe(400);
  });
});

describe('POST /api/events/:id/replay', () => {
  it('creates new pending deliveries for the source targets', async () => {
    const eventId = await seedEvent(t.db, {
      sourceId: 'payments',
      targetIds: ['billing', 'orders'],
    });
    const res = await post(`/api/events/${eventId}/replay`).send();
    expect(res.status).toBe(201);
    const { deliveries } = res.body as {
      deliveries: { id: string; targetId: string; status: string }[];
    };
    expect(deliveries.map((d) => d.targetId).sort()).toEqual(['billing', 'orders']);
    expect(deliveries.every((d) => d.status === 'pending')).toBe(true);
    expect(await t.db.delivery.count({ where: { eventId } })).toBe(4);
    expect(ctx.metrics.get('replays_total')).toBe(2);
  });

  it('replays to a chosen subset of targets', async () => {
    const eventId = await seedEvent(t.db, {
      sourceId: 'payments',
      targetIds: ['billing', 'orders'],
    });
    const res = await post(`/api/events/${eventId}/replay`).send({ targets: ['orders'] });
    expect(res.status).toBe(201);
    expect((res.body as { deliveries: unknown[] }).deliveries).toHaveLength(1);
  });

  it('delivers the replayed event again with the original payload', async () => {
    const eventId = await seedEvent(t.db, { body: '{"replay":"me"}' });
    const { worker, forwarder } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await worker.runOnce();
    await post(`/api/events/${eventId}/replay`).send().expect(201);
    await worker.runOnce();
    await forwarder.close();
    expect(target.requests.map((r) => r.body.toString())).toEqual([
      '{"replay":"me"}',
      '{"replay":"me"}',
    ]);
    const ids = new Set(target.requests.map((r) => r.headers['x-hookrelay-delivery-id']));
    expect(ids.size).toBe(2);
    expect(new Set(target.requests.map((r) => r.headers['x-hookrelay-event-id'])).size).toBe(1);
  });

  it.each([
    ['unknown target', { targets: ['nope'] }],
    ['target of a different source', { targets: ['billing'] }],
    ['empty list', { targets: [] }],
    ['duplicate-free but wrong type', { targets: [1] }],
    ['unexpected property', { extra: true }],
  ])('rejects %s with 400', async (_name, payload) => {
    const eventId = await seedEvent(t.db);
    const res = await post(`/api/events/${eventId}/replay`).send(payload);
    expect(res.status).toBe(400);
    expect(await t.db.delivery.count()).toBe(1);
  });

  it('rejects malformed JSON with 400', async () => {
    const eventId = await seedEvent(t.db);
    const res = await post(`/api/events/${eventId}/replay`)
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.code).toBe('invalid_json');
  });

  it('returns 404 for an unknown event and 409 when the body was purged', async () => {
    expect(
      (await post('/api/events/00000000-0000-7000-8000-000000000000/replay').send()).status,
    ).toBe(404);
    expect((await post('/api/events/nope/replay').send()).status).toBe(404);
    const eventId = await seedEvent(t.db);
    await t.pool.query(`UPDATE events SET body = NULL, body_purged = true`);
    const res = await post(`/api/events/${eventId}/replay`).send();
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('body_purged');
  });

  it('falls back to the existing delivery targets when the source is no longer configured', async () => {
    const eventId = await seedEvent(t.db, { sourceId: 'retired-source' });
    const res = await post(`/api/events/${eventId}/replay`).send();
    expect(res.status).toBe(201);
    expect((res.body as { deliveries: { targetId: string }[] }).deliveries[0]?.targetId).toBe(
      'orders',
    );
  });
});

describe('dead letters', () => {
  async function makeDead(): Promise<string> {
    await seedEvent(t.db);
    target.respondWithSequence([400]);
    const { worker, forwarder } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await worker.runOnce();
    await forwarder.close();
    return (await t.db.delivery.findFirstOrThrow()).id;
  }

  it('lists dead deliveries with their diagnosis, newest first, paginated', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await makeDead2(i));
    const first = (await get('/api/deliveries/dead?limit=2')).body as Page<{
      id: string;
      deadReason: string;
      lastStatus: number;
    }>;
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.data[0]).toMatchObject({ deadReason: 'permanent_status', lastStatus: 400 });
    const second = (await get(`/api/deliveries/dead?limit=2&cursor=${first.nextCursor}`))
      .body as Page<{ id: string }>;
    expect([...first.data, ...second.data].map((d) => d.id)).toEqual([...ids].reverse());
    expect(second.nextCursor).toBeNull();

    async function makeDead2(i: number): Promise<string> {
      await seedEvent(t.db, { deliveryId: `dead-${i}` });
      target.respondWithSequence([400]);
      const { worker, forwarder } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
      await worker.runOnce();
      await forwarder.close();
      const row = await t.db.delivery.findFirstOrThrow({
        where: { event: { deliveryId: `dead-${i}` } },
      });
      return row.id;
    }
  });

  it('excludes deliveries that are not dead', async () => {
    await seedEvent(t.db);
    const res = await get('/api/deliveries/dead');
    expect((res.body as Page<unknown>).data).toEqual([]);
  });

  it('retries a dead delivery with a fresh budget and delivers it', async () => {
    const id = await makeDead();
    target.respondWithSequence([200]);

    const res = await post(`/api/deliveries/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      status: 'pending',
      attempts: 1,
      attemptsBase: 1,
      deadReason: null,
    });

    const { worker, forwarder } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await worker.runOnce();
    await forwarder.close();
    const row = await t.db.delivery.findUniqueOrThrow({
      where: { id },
      include: { attemptLog: true },
    });
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(row.attemptLog.map((a) => a.attemptNumber).sort()).toEqual([1, 2]);
    expect(ctx.metrics.get('manual_retries_total')).toBe(1);
  });

  it('refuses to retry deliveries that are not dead, and a second retry', async () => {
    await seedEvent(t.db);
    const pending = await t.db.delivery.findFirstOrThrow();
    const res = await post(`/api/deliveries/${pending.id}/retry`);
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('not_dead');

    const id = await makeDead();
    expect((await post(`/api/deliveries/${id}/retry`)).status).toBe(200);
    expect((await post(`/api/deliveries/${id}/retry`)).status).toBe(409);
  });

  it('returns 404 for unknown or malformed IDs', async () => {
    expect((await post('/api/deliveries/00000000-0000-7000-8000-000000000000/retry')).status).toBe(
      404,
    );
    expect((await post('/api/deliveries/nope/retry')).status).toBe(404);
  });

  it('refuses to retry when the body has been purged', async () => {
    const id = await makeDead();
    await t.pool.query(`UPDATE events SET body = NULL, body_purged = true`);
    const res = await post(`/api/deliveries/${id}/retry`);
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('body_purged');
    expect((await t.db.delivery.findUniqueOrThrow({ where: { id } })).status).toBe('dead');
  });

  it('only one of several concurrent retries requeues the delivery', async () => {
    const id = await makeDead();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(`/api/deliveries/${id}/retry`)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });
});

describe('GET /api/metrics', () => {
  it('exposes the counters', async () => {
    await request(ctx.app).post('/hooks/github').send('{}');
    const res = await get('/api/metrics');
    expect(res.status).toBe(200);
    expect((res.body as { counters: unknown[] }).counters).toEqual(
      expect.arrayContaining([
        {
          name: 'invalid_signatures_total',
          labels: { source: 'github', reason: 'missing_header' },
          value: 1,
        },
      ]),
    );
  });
});

describe('logging', () => {
  it('never logs the admin API key', async () => {
    await get('/api/events');
    await request(ctx.app).get('/api/events').set('Authorization', 'Bearer wrong-key-value-123456');
    const out = ctx.logs.output();
    expect(out).not.toContain(TEST_SECRETS.admin);
    expect(out).not.toContain('wrong-key-value-123456');
  });
});
