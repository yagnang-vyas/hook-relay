import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { relaySignature } from '../../src/delivery/forward.js';
// @ts-expect-error The example is plain JavaScript without type declarations.
import { createEchoServer } from '../../examples/echo-target.mjs';

const SECRET = 'relay-signing-secret-0123456789';
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(failFirst = 0): Promise<{ url: string; logs: string[] }> {
  const logs: string[] = [];
  server = (createEchoServer as (o: object) => Server)({
    secret: SECRET,
    failFirst,
    log: (line: string) => logs.push(line),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, logs };
}

const send = (url: string, body: string, eventId: string, signature?: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'x-hookrelay-event-id': eventId,
      'x-hookrelay-attempt': '1',
      'x-hookrelay-signature': signature ?? relaySignature(SECRET, Buffer.from(body)),
    },
    body,
  });

describe('examples/echo-target.mjs', () => {
  it('accepts a correctly signed request and deduplicates on the event ID', async () => {
    const { url, logs } = await start();
    expect((await send(url, '{"a":1}', 'evt-1')).status).toBe(200);
    expect((await send(url, '{"a":1}', 'evt-1')).status).toBe(200);
    expect(logs[0]).toContain('7 bytes');
    expect(logs[1]).toContain('already handled');
  });

  it('answers GET health probes without logging them', async () => {
    const { url, logs } = await start();
    expect((await fetch(url)).status).toBe(200);
    expect(logs).toEqual([]);
  });

  it('rejects a bad signature', async () => {
    const { url } = await start();
    expect((await send(url, '{}', 'evt-2', 'sha256=deadbeef')).status).toBe(401);
    expect(
      (await send(url, '{}', 'evt-2', relaySignature('other-secret-value-xyz', Buffer.from('{}'))))
        .status,
    ).toBe(401);
  });

  it('can simulate an outage for the first requests', async () => {
    const { url } = await start(2);
    expect((await send(url, '{}', 'evt-3')).status).toBe(503);
    expect((await send(url, '{}', 'evt-3')).status).toBe(503);
    expect((await send(url, '{}', 'evt-3')).status).toBe(200);
  });
});
