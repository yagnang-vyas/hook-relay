import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { closeHttpServer, installShutdown, type ShutdownStep } from '../../src/shutdown.js';
import { captureLogger } from '../helpers.js';

function setup(
  steps: ShutdownStep[],
  overrides: { graceMs?: number; forceExitSlackMs?: number } = {},
) {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const { logger, output } = captureLogger();
  const handle = installShutdown({
    logger,
    graceMs: overrides.graceMs ?? 1_000,
    ...(overrides.forceExitSlackMs !== undefined
      ? { forceExitSlackMs: overrides.forceExitSlackMs }
      : {}),
    steps,
    exit: (code) => exits.push(code),
    target: emitter as unknown as Pick<NodeJS.Process, 'on'>,
  });
  return { emitter, exits, handle, output };
}

describe('installShutdown', () => {
  it('runs steps in order, passes the remaining grace, and exits 0', async () => {
    const order: string[] = [];
    const graces: number[] = [];
    const { handle, exits, output } = setup([
      {
        name: 'one',
        run: (g) => {
          order.push('one');
          graces.push(g);
        },
      },
      {
        name: 'two',
        run: async (g) => {
          await new Promise((r) => setTimeout(r, 30));
          order.push('two');
          graces.push(g);
        },
      },
      {
        name: 'three',
        run: (g) => {
          order.push('three');
          graces.push(g);
        },
      },
    ]);
    await handle.shutdown('test');
    expect(order).toEqual(['one', 'two', 'three']);
    expect(exits).toEqual([0]);
    expect(graces[0]).toBeLessThanOrEqual(1_000);
    expect(graces[2]).toBeLessThan(graces[0] ?? 0);
    expect(output()).toContain('shutdown complete');
  });

  it('keeps going after a failing step and exits 1', async () => {
    const ran: string[] = [];
    const { handle, exits, output } = setup([
      {
        name: 'bad',
        run: () => {
          throw new Error('boom');
        },
      },
      {
        name: 'good',
        run: () => {
          ran.push('good');
        },
      },
    ]);
    await handle.shutdown('test');
    expect(ran).toEqual(['good']);
    expect(exits).toEqual([1]);
    expect(output()).toContain('shutdown step failed');
  });

  it('exits immediately on a second signal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { handle, exits, output } = setup([{ name: 'slow', run: () => gate }]);
    const first = handle.shutdown('SIGTERM');
    await handle.shutdown('SIGTERM');
    expect(exits).toEqual([1]);
    expect(output()).toContain('second shutdown signal');
    release();
    await first;
    expect(exits).toEqual([1, 0]);
  });

  it('forces exit if a step hangs past the grace period', async () => {
    const { handle, exits, output } = setup(
      [{ name: 'hang', run: () => new Promise(() => undefined) }],
      {
        graceMs: 20,
        forceExitSlackMs: 30,
      },
    );
    void handle.shutdown('test');
    await new Promise((r) => setTimeout(r, 150));
    expect(exits).toEqual([1]);
    expect(output()).toContain('forcing exit');
  });

  it('is triggered by SIGTERM and SIGINT', async () => {
    const calls: string[] = [];
    const { emitter, exits } = setup([
      {
        name: 'step',
        run: () => {
          calls.push('ran');
        },
      },
    ]);
    emitter.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['ran']);
    expect(exits).toEqual([0]);
    expect(emitter.listenerCount('SIGINT')).toBe(1);
  });
});

describe('closeHttpServer', () => {
  async function listen(handler?: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it('resolves promptly when nothing is connected', async () => {
    const { server } = await listen();
    await closeHttpServer(server, 5_000);
    expect(server.listening).toBe(false);
  });

  it('lets an in-flight request finish before closing', async () => {
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => res.end('done'), 150);
    });
    const response = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    await closeHttpServer(server, 5_000);
    expect(await response).toBe('done');
  });

  it('destroys connections that outlive the grace period', async () => {
    const { server, port } = await listen(() => undefined);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    // A request that never completes: the server cannot close gracefully.
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc');
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await closeHttpServer(server, 100);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
    socket.destroy();
  });
});
