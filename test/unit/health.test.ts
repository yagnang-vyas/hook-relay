import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import type { Readiness } from '../../src/db.js';
import { Metrics } from '../../src/metrics.js';
import { captureLogger } from '../helpers.js';

function makeApp(readiness: Readiness) {
  const captured = captureLogger();
  const app = createApp({
    config: {} as Config,
    logger: captured.logger,
    metrics: new Metrics(),
    readiness,
  });
  return { app, captured };
}

describe('health endpoints', () => {
  it('GET /healthz reports the process is up', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz is 200 when ready', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('GET /readyz is 503 with a reason when not ready', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: false, reason: 'database_unreachable' }));
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', reason: 'database_unreachable' });
  });
});

describe('request handling', () => {
  it('generates a request ID and echoes it', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a well-formed inbound request ID', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/healthz').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('replaces a malformed inbound request ID', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/healthz').set('X-Request-Id', 'bad id with spaces');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with the standard error shape', async () => {
    const { app } = makeApp(() => Promise.resolve({ ok: true }));
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'not_found',
        message: 'Route not found',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('turns unexpected errors into a generic 500 without leaking details', async () => {
    const { app, captured } = makeApp(() =>
      Promise.reject(new Error('database password is hunter2')),
    );
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(captured.records().some((r) => r['msg'] === 'unhandled error')).toBe(true);
  });

  it('logs one structured line per request without headers', async () => {
    const { app, captured } = makeApp(() => Promise.resolve({ ok: true }));
    await request(app).get('/healthz').set('Authorization', 'Bearer leak-me');
    const line = captured.records().find((r) => r['msg'] === 'request completed');
    expect(line).toMatchObject({ method: 'GET', route: '/healthz', status: 200 });
    expect(captured.output()).not.toContain('leak-me');
  });
});
