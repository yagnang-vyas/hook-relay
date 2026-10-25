import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTarget } from '../fixtures/fake-target.js';
import { githubSignature } from '../fixtures/sign.js';
import { TEST_SECRETS } from '../helpers.js';
import {
  createTestApp,
  createTestWorker,
  seedEvent,
  setupTestDb,
  type TestApp,
  type TestDb,
} from './harness.js';

/**
 * Checks that real responses conform to the schemas in openapi.yaml, so the documentation
 * cannot drift from the behaviour.
 */

const specPath = new URL('../../openapi.yaml', import.meta.url).pathname;
type Spec = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema: object }> }> }>
  >;
};
let spec: Spec;
// ajv-formats is CommonJS; under NodeNext its default export is typed as the module namespace.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

let t: TestDb;
let ctx: TestApp;
const target = new FakeTarget();
const auth = { Authorization: `Bearer ${TEST_SECRETS.admin}` };

beforeAll(async () => {
  spec = (await SwaggerParser.dereference(specPath)) as unknown as Spec;
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

function expectConforms(path: string, method: string, status: number, body: unknown): void {
  const schema =
    spec.paths[path]?.[method]?.responses[String(status)]?.content?.['application/json']?.schema;
  expect(
    schema,
    `${method.toUpperCase()} ${path} ${status} has a documented JSON schema`,
  ).toBeDefined();
  const validate = ajv.compile(schema as object);
  const ok = validate(body);
  expect(ok, JSON.stringify(validate.errors, null, 2) + '\n' + JSON.stringify(body, null, 2)).toBe(
    true,
  );
}

describe('responses conform to openapi.yaml', () => {
  it('ingest: 202, 200 duplicate and error shapes', async () => {
    const body = '{"a":1}';
    const post = () =>
      request(ctx.app)
        .post('/hooks/github')
        .set('X-GitHub-Delivery', 'contract-1')
        .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
        .send(body);
    const accepted = await post();
    expectConforms('/hooks/{sourceId}', 'post', 202, accepted.body);
    const duplicate = await post();
    expect(duplicate.status).toBe(200);
    expectConforms('/hooks/{sourceId}', 'post', 200, duplicate.body);

    const unauthorized = await request(ctx.app).post('/hooks/github').send(body);
    expectConforms('/hooks/{sourceId}', 'post', 401, unauthorized.body);
    const unknown = await request(ctx.app).post('/hooks/nope').send(body);
    expectConforms('/hooks/{sourceId}', 'post', 404, unknown.body);
  });

  it('admin: list, detail, replay, dead letters, retry, metrics', async () => {
    const eventId = await seedEvent(t.db, {
      sourceId: 'payments',
      targetIds: ['billing', 'orders'],
    });
    target.respondWithSequence([400, 500, 200]);
    const { worker, forwarder } = createTestWorker(t, {
      ordersUrl: `${target.url}/hook`,
      billingUrl: `${target.url}/billing`,
    });
    await worker.runOnce();
    await forwarder.close();

    const list = await request(ctx.app).get('/api/events').set(auth);
    expect(list.status).toBe(200);
    expectConforms('/api/events', 'get', 200, list.body);

    const detail = await request(ctx.app).get(`/api/events/${eventId}?includeBody=true`).set(auth);
    expectConforms('/api/events/{id}', 'get', 200, detail.body);
    const noBody = await request(ctx.app).get(`/api/events/${eventId}`).set(auth);
    expectConforms('/api/events/{id}', 'get', 200, noBody.body);

    const replay = await request(ctx.app)
      .post(`/api/events/${eventId}/replay`)
      .set(auth)
      .send({ targets: ['orders'] });
    expect(replay.status).toBe(201);
    expectConforms('/api/events/{id}/replay', 'post', 201, replay.body);

    const dead = await request(ctx.app).get('/api/deliveries/dead').set(auth);
    expect(dead.status).toBe(200);
    expect((dead.body as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expectConforms('/api/deliveries/dead', 'get', 200, dead.body);

    const deadId = (dead.body as { data: { id: string }[] }).data[0]?.id;
    const retry = await request(ctx.app).post(`/api/deliveries/${deadId}/retry`).set(auth);
    expect(retry.status).toBe(200);
    expectConforms('/api/deliveries/{id}/retry', 'post', 200, retry.body);

    const metrics = await request(ctx.app).get('/api/metrics').set(auth);
    expectConforms('/api/metrics', 'get', 200, metrics.body);
  });

  it('admin: documented error responses', async () => {
    const unauthorized = await request(ctx.app).get('/api/events');
    expectConforms('/api/events', 'get', 401, unauthorized.body);
    const badRequest = await request(ctx.app).get('/api/events?limit=0').set(auth);
    expectConforms('/api/events', 'get', 400, badRequest.body);
    const notFound = await request(ctx.app)
      .get('/api/events/00000000-0000-7000-8000-000000000000')
      .set(auth);
    expectConforms('/api/events/{id}', 'get', 404, notFound.body);
    const eventId = await seedEvent(t.db);
    await t.pool.query(`UPDATE events SET body = NULL, body_purged = true`);
    const conflict = await request(ctx.app).post(`/api/events/${eventId}/replay`).set(auth).send();
    expectConforms('/api/events/{id}/replay', 'post', 409, conflict.body);
  });

  it('health: healthz and readyz', async () => {
    expectConforms('/healthz', 'get', 200, (await request(ctx.app).get('/healthz')).body);
    expectConforms('/readyz', 'get', 200, (await request(ctx.app).get('/readyz')).body);
  });
});
