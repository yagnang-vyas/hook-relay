import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyStatus,
  createForwarder,
  describeError,
  relaySignature,
  releaseBody,
  type ForwardRequest,
  type Forwarder,
} from '../../src/delivery/forward.js';
import { SsrfError } from '../../src/delivery/ssrf.js';
import { FakeTarget } from '../fixtures/fake-target.js';
import { hmacHex } from '../fixtures/sign.js';

const SECRET = 'relay-signing-secret-0123456789';
const target = new FakeTarget();
let forwarder: Forwarder;
let blockedForwarder: Forwarder;

beforeAll(async () => {
  await target.start();
  forwarder = createForwarder({
    network: { allowPrivateTargets: new Set(['127.0.0.1']), allowHttp: true },
    relaySigningSecret: SECRET,
  });
  blockedForwarder = createForwarder({
    network: { allowPrivateTargets: new Set(), allowHttp: true },
    relaySigningSecret: SECRET,
  });
});
afterAll(async () => {
  await forwarder.close();
  await blockedForwarder.close();
  await target.stop();
});
afterEach(() => {
  target.reset();
  target.respondWithSequence([200]);
});

function request(overrides: Partial<ForwardRequest> = {}): ForwardRequest {
  return {
    target: {
      id: 'orders',
      url: `${target.url}/hook?x=1`,
      timeoutMs: 1_000,
      maxAttempts: 3,
      backoff: { baseMs: 10, maxMs: 100 },
    },
    eventId: 'evt-1',
    deliveryId: 'del-1',
    attempt: 2,
    body: Buffer.from('{"hello":"world"}'),
    contentType: 'application/json',
    ...overrides,
  };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('forward', () => {
  it('posts the original body and content type with HookRelay headers', async () => {
    const outcome = await forwarder.forward(request());
    expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });

    const [seen] = target.requests;
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('/hook?x=1');
    expect(seen?.body.toString()).toBe('{"hello":"world"}');
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.headers['x-hookrelay-event-id']).toBe('evt-1');
    expect(seen?.headers['x-hookrelay-delivery-id']).toBe('del-1');
    expect(seen?.headers['x-hookrelay-attempt']).toBe('2');
    expect(seen?.headers['x-hookrelay-signature']).toBe(
      `sha256=${hmacHex(SECRET, '{"hello":"world"}')}`,
    );
    expect(seen?.headers['user-agent']).toMatch(/^HookRelay\//);
  });

  it('sends non-UTF-8 bodies byte for byte and defaults the content type', async () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x0a]);
    await forwarder.forward(request({ body, contentType: null }));
    expect(target.requests[0]?.body.equals(body)).toBe(true);
    expect(target.requests[0]?.headers['content-type']).toBe('application/octet-stream');
  });

  it('sends an empty body', async () => {
    const outcome = await forwarder.forward(request({ body: Buffer.alloc(0) }));
    expect(outcome.kind).toBe('delivered');
    expect(target.requests[0]?.body.length).toBe(0);
  });

  it.each([
    [200, 'delivered'],
    [201, 'delivered'],
    [204, 'delivered'],
    [400, 'permanent'],
    [401, 'permanent'],
    [404, 'permanent'],
    [410, 'permanent'],
    [422, 'permanent'],
    [408, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [502, 'retryable'],
    [503, 'retryable'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    target.respondWithSequence([status]);
    const outcome = await forwarder.forward(request());
    expect(outcome.kind).toBe(kind);
    expect('statusCode' in outcome ? outcome.statusCode : undefined).toBe(status);
  });

  it('does not follow redirects and treats them as retryable', async () => {
    const other = await new FakeTarget().start();
    try {
      target.respondWith((_req, res) => {
        res.statusCode = 302;
        res.setHeader('location', `${other.url}/elsewhere`);
        res.end();
      });
      const outcome = await forwarder.forward(request());
      expect(outcome).toMatchObject({ kind: 'retryable', statusCode: 302 });
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.stop();
    }
  });

  it('never returns the response body', async () => {
    target.respondWith((_req, res) => {
      res.statusCode = 500;
      res.end('secret-response-marker');
    });
    const outcome = await forwarder.forward(request());
    expect(JSON.stringify(outcome)).not.toContain('secret-response-marker');
  });

  it('times out slow targets as retryable', async () => {
    target.respondWith(() => new Promise(() => undefined));
    const req = request();
    req.target = { ...req.target, timeoutMs: 150 };
    const outcome = await forwarder.forward(req);
    expect(outcome).toEqual({ kind: 'retryable', error: 'request timed out' });
  });

  it('aborts when the caller signals, as retryable', async () => {
    target.respondWith(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = forwarder.forward(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({ kind: 'retryable', error: 'request aborted' });
  });

  it('reports connection failures as retryable with the error code', async () => {
    const req = request();
    req.target = { ...req.target, url: `http://127.0.0.1:${await closedPort()}/hook` };
    const outcome = await forwarder.forward(req);
    expect(outcome).toMatchObject({ kind: 'retryable' });
    expect((outcome as { error: string }).error).toMatch(/ECONNREFUSED/);
  });

  it('blocks private targets that are not allow-listed without sending anything', async () => {
    const outcome = await blockedForwarder.forward(request());
    expect(outcome.kind).toBe('retryable');
    expect((outcome as { error: string }).error).toMatch(/^blocked: .*loopback/);
    expect(target.requests).toHaveLength(0);
  });

  it('blocks non-http schemes', async () => {
    const req = request();
    req.target = { ...req.target, url: 'ftp://127.0.0.1/x' };
    const outcome = await forwarder.forward(req);
    expect(outcome).toMatchObject({
      kind: 'retryable',
      error: expect.stringContaining('scheme') as string,
    });
  });

  it('refuses http when it is not allowed', async () => {
    const httpsOnly = createForwarder({
      network: { allowPrivateTargets: new Set(['127.0.0.1']), allowHttp: false },
      relaySigningSecret: SECRET,
    });
    try {
      const outcome = await httpsOnly.forward(request());
      expect(outcome).toMatchObject({ kind: 'retryable' });
      expect(target.requests).toHaveLength(0);
    } finally {
      await httpsOnly.close();
    }
  });

  it('blocks a rebinding resolver at connect time even if the pre-flight check passed', async () => {
    // The pre-flight resolver claims the host is public; the connector's own lookup still
    // sees the real (loopback) answer for "localhost" and refuses it.
    const rebinding = createForwarder({
      network: { allowPrivateTargets: new Set(), allowHttp: true },
      relaySigningSecret: SECRET,
      resolver: () => Promise.resolve(['93.184.216.34']),
    });
    try {
      const req = request();
      const port = new URL(target.url).port;
      req.target = { ...req.target, url: `http://localhost:${port}/hook` };
      const outcome = await rebinding.forward(req);
      expect(outcome.kind).toBe('retryable');
      expect((outcome as { error: string }).error).toMatch(/^blocked: /);
      expect(target.requests).toHaveLength(0);
    } finally {
      await rebinding.close();
    }
  });
});

describe('releaseBody', () => {
  it('cancels the body and tolerates a missing one', async () => {
    let cancelled = false;
    await releaseBody({
      body: {
        cancel: () => {
          cancelled = true;
          return Promise.resolve();
        },
      },
    });
    expect(cancelled).toBe(true);
    await expect(releaseBody({ body: null })).resolves.toBeUndefined();
  });

  it('swallows a failing cancel so the outcome is unaffected', async () => {
    await expect(
      releaseBody({ body: { cancel: () => Promise.reject(new Error('stream already errored')) } }),
    ).resolves.toBeUndefined();
  });
});

describe('helpers', () => {
  it('classifyStatus covers the boundaries', () => {
    expect(classifyStatus(199).kind).toBe('retryable');
    expect(classifyStatus(299).kind).toBe('delivered');
    expect(classifyStatus(300).kind).toBe('retryable');
    expect(classifyStatus(399).kind).toBe('retryable');
    expect(classifyStatus(400).kind).toBe('permanent');
    expect(classifyStatus(499).kind).toBe('permanent');
    expect(classifyStatus(500).kind).toBe('retryable');
  });

  it('relaySignature is a sha256 HMAC over the body', () => {
    expect(relaySignature('k', Buffer.from('abc'))).toBe(`sha256=${hmacHex('k', 'abc')}`);
  });

  it('describeError never includes request details', () => {
    expect(describeError(new SsrfError('target resolves to a private address'))).toBe(
      'blocked: target resolves to a private address',
    );
    const timeout = new Error('x');
    timeout.name = 'TimeoutError';
    expect(describeError(timeout)).toBe('request timed out');
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(describeError(abort)).toBe('request aborted');
    expect(
      describeError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('c'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe('network error: ECONNRESET');
    expect(describeError(new TypeError('fetch failed', { cause: new SsrfError('bad') }))).toBe(
      'blocked: bad',
    );
    expect(describeError(Object.assign(new Error('boom'), { code: 'EPIPE' }))).toBe(
      'network error: EPIPE',
    );
    expect(describeError(new Error('plain'))).toBe('Error: plain');
    expect(describeError(new Error('y'.repeat(1000))).length).toBe(300);
    expect(describeError('string')).toBe('unknown error');
  });
});
