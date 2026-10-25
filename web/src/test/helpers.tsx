import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ConnectionProvider } from '../api/connection';
import { App } from '../App';

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (
  call: MockCall,
) =>
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>;

/** Minimal fetch mock: routes are matched on "METHOD /path" ignoring the query string. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: MockCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call: MockCall = {
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const path = url.split('?')[0] ?? url;
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'no route', requestId: 'mock' } }),
        {
          status: 404,
        },
      );
    }
    const out = await handler(call);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export function renderApp(
  fetchImpl: typeof fetch,
  opts: { apiKey?: string | undefined; hash?: string } = {},
) {
  window.location.hash = opts.hash ?? '';
  return render(
    <ConnectionProvider
      fetchImpl={fetchImpl}
      initialBaseUrl=""
      {...(opts.apiKey !== undefined ? { initialApiKey: opts.apiKey } : {})}
    >
      <App />
    </ConnectionProvider>,
  );
}

export const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export function eventSummary(n: number, over: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    sourceId: 'github',
    deliveryId: `dlv-${n}`,
    generatedId: false,
    contentType: 'application/json',
    headers: {},
    bodySize: 42,
    bodyPurged: false,
    receivedAt: '2025-01-01T00:00:00.000Z',
    deliveries: [
      { id: uuid(100 + n), targetId: 'orders-service', status: 'delivered', attempts: 1 },
    ],
    ...over,
  };
}

export function deliveryRecord(n: number, over: Record<string, unknown> = {}) {
  return {
    id: uuid(100 + n),
    eventId: uuid(n),
    targetId: 'orders-service',
    status: 'dead',
    attempts: 8,
    attemptsBase: 0,
    nextAttemptAt: '2025-01-01T00:00:00.000Z',
    leaseUntil: null,
    lastStatus: 503,
    lastError: 'target responded with HTTP 503',
    deadReason: 'max_attempts',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
    deliveredAt: null,
    attemptHistory: [
      {
        id: uuid(500 + n),
        attemptNumber: 1,
        startedAt: '2025-01-01T00:00:01.000Z',
        durationMs: 120,
        statusCode: 503,
        error: 'target responded with HTTP 503',
      },
    ],
    ...over,
  };
}
