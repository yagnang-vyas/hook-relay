import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTarget } from '../fixtures/fake-target.js';
import { githubSignature, hmacHex } from '../fixtures/sign.js';
import { TEST_SECRETS } from '../helpers.js';
import { createTestApp, createTestWorker, setupTestDb, type TestDb } from './harness.js';

const BODY_MARKER = 'BODY-MARKER-4f9c1d7e-never-log-me';
const AUTH_MARKER = 'AUTH-MARKER-bearer-value';
const body = JSON.stringify({ customer: BODY_MARKER, card_last4: '4242' });

let t: TestDb;
const target = new FakeTarget();

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
});

/** Everything sensitive that might be tempting to log. */
function forbidden(extra: string[] = []): string[] {
  return [
    BODY_MARKER,
    AUTH_MARKER,
    TEST_SECRETS.github,
    TEST_SECRETS.paymentsNew,
    TEST_SECRETS.paymentsOld,
    TEST_SECRETS.admin,
    TEST_SECRETS.relay,
    hmacHex(TEST_SECRETS.github, body),
    hmacHex('wrong-secret', body),
    hmacHex(TEST_SECRETS.relay, body),
    ...extra,
  ];
}

function expectClean(output: string, extra: string[] = []): void {
  for (const value of forbidden(extra)) {
    expect(output, `log output leaked ${value.slice(0, 12)}...`).not.toContain(value);
  }
}

describe('log redaction across ingest and forward', () => {
  it('logs no secrets, signatures, authorization headers or bodies on the happy path', async () => {
    const app = createTestApp(t, { ordersUrl: `${target.url}/hook` });
    const res = await request(app.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${AUTH_MARKER}`)
      .set('X-GitHub-Delivery', 'log-happy')
      .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
      .send(body);
    expect(res.status).toBe(202);

    const { worker, logs } = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await worker.runOnce();
    expect(target.requests).toHaveLength(1);

    const output = app.logs.output() + logs.output();
    expect(output).toContain('request completed');
    expect(output).toContain('delivery attempt finished');
    expectClean(output, [githubSignature(TEST_SECRETS.github, body)]);
  });

  it('logs no sensitive values when a signature is rejected', async () => {
    const app = createTestApp(t);
    const bad = githubSignature('wrong-secret', body);
    const res = await request(app.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${AUTH_MARKER}`)
      .set('X-Hub-Signature-256', bad)
      .send(body);
    expect(res.status).toBe(401);
    expect(app.logs.output()).toContain('rejected webhook with invalid signature');
    expectClean(app.logs.output(), [bad]);
  });

  it('logs no payloads when forwarding fails or is blocked', async () => {
    const app = createTestApp(t, { ordersUrl: `${target.url}/hook` });
    await request(app.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', 'log-fail')
      .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
      .send(body)
      .expect(202);

    target.respondWith((_req, res) => {
      res.statusCode = 500;
      res.end(`echoed back: ${BODY_MARKER}`);
    });
    const failing = createTestWorker(t, { ordersUrl: `${target.url}/hook` });
    await failing.worker.runOnce();

    await t.pool.query(`UPDATE deliveries SET next_attempt_at = now()`);
    const blocked = createTestWorker(t, { ordersUrl: `${target.url}/hook`, blockPrivate: true });
    await blocked.worker.runOnce();

    const output = failing.logs.output() + blocked.logs.output();
    expect(output).toContain('delivery attempt finished');
    expectClean(output);
    // The target's own response body is never stored either.
    const stored = await t.pool.query('SELECT last_error FROM deliveries');
    expect(JSON.stringify(stored.rows)).not.toContain(BODY_MARKER);
  });

  it('reduces database errors that echo the payload to their type and code', async () => {
    class PrismaClientKnownRequestError extends Error {
      override name = 'PrismaClientKnownRequestError';
      code = 'P2010';
    }
    const failing = t.db.$extends({
      query: {
        event: {
          create() {
            return Promise.reject(
              new PrismaClientKnownRequestError(`Invalid invocation: data: { body: ${body} }`),
            );
          },
        },
      },
    });
    const app = createTestApp(t, { db: failing as unknown as typeof t.db });
    const res = await request(app.app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', 'log-dberr')
      .set('X-Hub-Signature-256', githubSignature(TEST_SECRETS.github, body))
      .send(body);
    expect(res.status).toBe(500);
    expect(app.logs.output()).toContain('unhandled error');
    expect(app.logs.output()).toContain('P2010');
    expectClean(app.logs.output());
  });
});
