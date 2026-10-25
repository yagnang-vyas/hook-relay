import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';

function client(fetchImpl: typeof fetch, key: string | undefined = 'k-test', timeoutMs?: number) {
  return new ApiClient({
    baseUrl: 'http://relay.test/',
    getApiKey: () => key,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('ApiClient', () => {
  it('sends the bearer key, omits credentials and builds the query string', async () => {
    const f = vi.fn(async () => json({ data: [], nextCursor: null }));
    await client(f as unknown as typeof fetch).listEvents({
      source: 'github',
      status: 'dead',
      limit: 25,
      cursor: 'abc',
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://relay.test/api/events?source=github&status=dead&limit=25&cursor=abc');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k-test');
    expect(init.credentials).toBe('omit');
  });

  it('does not call the network without a key', async () => {
    const f = vi.fn();
    await expect(client(f as unknown as typeof fetch, '').getMetrics()).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'missing_api_key',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('does not send the key to health endpoints', async () => {
    const f = vi.fn(async () => json({ status: 'ok' }));
    await client(f as unknown as typeof fetch).liveness();
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [400, 'validation'],
    [503, 'server'],
  ])('maps HTTP %i to %s and keeps code, message and request ID', async (status, kind) => {
    const f = vi.fn(async () =>
      json(
        { error: { code: 'srv_code', message: 'Server says no', requestId: 'req-123' } },
        status,
      ),
    );
    const err = (await client(f as unknown as typeof fetch)
      .getMetrics()
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status,
      kind,
      code: 'srv_code',
      message: 'Server says no',
      requestId: 'req-123',
    });
  });

  it('falls back to the X-Request-Id header for non-JSON errors', async () => {
    const f = vi.fn(
      async () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'x-request-id': 'proxy-1' },
        }),
    );
    const err = (await client(f as unknown as typeof fetch)
      .getMetrics()
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, kind: 'server', requestId: 'proxy-1' });
  });

  it('reports network failures with a helpful message', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client(f as unknown as typeof fetch).getMetrics()).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('times out slow requests', async () => {
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await expect(client(f as unknown as typeof fetch, 'k', 20).getMetrics()).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('supports caller cancellation', async () => {
    const controller = new AbortController();
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const p = client(f as unknown as typeof fetch).getMetrics(controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('requests the body only when asked', async () => {
    const f = vi.fn(async () => json({}));
    const c = client(f as unknown as typeof fetch);
    await c.getEvent('id-1');
    await c.getEvent('id-1', { includeBody: true });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://relay.test/api/events/id-1');
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe(
      'http://relay.test/api/events/id-1?includeBody=true',
    );
  });

  it('posts replay with the documented body and retry without one', async () => {
    const f = vi.fn(async () => json({ deliveries: [] }, 201));
    const c = client(f as unknown as typeof fetch);
    await c.replayEvent('e1');
    await c.replayEvent('e1', ['orders-service']);
    await c.retryDelivery('d1');
    const bodies = f.mock.calls.map((x) => (x as unknown as [string, RequestInit])[1].body);
    expect(bodies).toEqual(['{}', '{"targets":["orders-service"]}', undefined]);
    expect((f.mock.calls[2] as unknown as [string, RequestInit])[1].method).toBe('POST');
  });

  it('reads readiness failures including the reason', async () => {
    const f = vi.fn(async () => json({ status: 'unavailable', reason: 'migrations_pending' }, 503));
    await expect(client(f as unknown as typeof fetch).readiness()).resolves.toEqual({
      ready: false,
      status: 'unavailable',
      reason: 'migrations_pending',
    });
  });
});
