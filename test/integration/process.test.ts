import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTarget } from '../fixtures/fake-target.js';
import { githubSignature } from '../fixtures/sign.js';
import { TEST_SECRETS } from '../helpers.js';
import { setupTestDb, type TestDb } from './harness.js';

/** Runs the real server entrypoint as a child process, to test signals and wiring end to end. */

let t: TestDb;
let dir: string;
const target = new FakeTarget();
let child: ChildProcess | undefined;
let logs = '';

beforeAll(async () => {
  t = await setupTestDb();
  await target.start();
  dir = mkdtempSync(join(tmpdir(), 'hookrelay-proc-'));
});
afterAll(async () => {
  await target.stop();
  await t.teardown();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.reset();
  target.reset();
});
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeConfig(): string {
  const path = join(dir, 'hookrelay.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      sources: [
        {
          id: 'github',
          secretEnv: 'GITHUB_WEBHOOK_SECRET',
          scheme: { type: 'hmac-sha256', header: 'X-Hub-Signature-256', format: 'sha256=hex' },
          deliveryIdHeader: 'X-GitHub-Delivery',
          targets: ['orders'],
        },
      ],
      targets: [{ id: 'orders', url: `${target.url}/hook`, timeoutMs: 20_000, maxAttempts: 3 }],
      network: { allowPrivateTargets: ['127.0.0.1'], allowHttp: true },
    }),
  );
  return path;
}

async function startServer(env: Record<string, string> = {}): Promise<number> {
  const port = await freePort();
  logs = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: t.databaseUrl,
      DATABASE_SCHEMA: t.schema,
      ADMIN_API_KEY: TEST_SECRETS.admin,
      RELAY_SIGNING_SECRET: TEST_SECRETS.relay,
      GITHUB_WEBHOOK_SECRET: TEST_SECRETS.github,
      CONFIG_PATH: writeConfig(),
      MIGRATIONS_DIR: 'prisma/migrations',
      PORT: String(port),
      HOST: '127.0.0.1',
      WORKER_POLL_INTERVAL_MS: '50',
      LEASE_SECONDS: '60',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => (logs += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (logs += d.toString()));
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  }, 20_000);
  return port;
}

function exited(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${timeoutMs}ms\n${logs}`)),
      timeoutMs,
    );
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function sendWebhook(port: number, id: string): Promise<number> {
  const body = '{"proc":true}';
  const res = await fetch(`http://127.0.0.1:${port}/hooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': id,
      'x-hub-signature-256': githubSignature(TEST_SECRETS.github, body),
    },
    body,
  });
  return res.status;
}

describe('server process', () => {
  it('rejects invalid configuration at startup with a clear message and exit code 1', async () => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: t.databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    expect(await exited(proc, 15_000)).toBe(1);
    expect(stderr).toContain('Invalid configuration');
    expect(stderr).toContain('ADMIN_API_KEY');
  });

  it('on SIGTERM finishes in-flight deliveries, stops accepting connections, and exits 0', async () => {
    const port = await startServer({ SHUTDOWN_GRACE_MS: '10000' });
    target.respondWith(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 1_000));
      res.statusCode = 200;
      res.end('ok');
    });

    expect(await sendWebhook(port, 'sig-1')).toBe(202);
    await waitFor(() => target.requests.length === 1);

    const done = exited(child as ChildProcess, 15_000);
    child?.kill('SIGTERM');
    expect(await done).toBe(0);

    const delivery = await t.db.delivery.findFirstOrThrow();
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 1 });
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(logs).toContain('shutting down');
    expect(logs).toContain('shutdown complete');
    expect(logs).not.toContain('shutdown step failed');
  });

  it('aborts requests that outlive the grace period; the delivery is retried, not lost', async () => {
    const port = await startServer({ SHUTDOWN_GRACE_MS: '300' });
    target.respondWith(() => new Promise(() => undefined));

    expect(await sendWebhook(port, 'sig-2')).toBe(202);
    await waitFor(() => target.requests.length === 1);

    const done = exited(child as ChildProcess, 15_000);
    child?.kill('SIGTERM');
    expect(await done).toBe(0);

    expect(await t.db.delivery.findFirstOrThrow()).toMatchObject({
      status: 'retrying',
      attempts: 1,
      lastError: 'request aborted',
    });
    expect(logs).toContain('aborting in-flight deliveries');
  });

  it('recovers a delivery left in flight by a killed process', async () => {
    const port = await startServer({ SHUTDOWN_GRACE_MS: '300' });
    target.respondWith(() => new Promise(() => undefined));
    expect(await sendWebhook(port, 'sig-3')).toBe(202);
    await waitFor(() => target.requests.length === 1);

    child?.kill('SIGKILL'); // crash: no chance to clean up
    await exited(child as ChildProcess, 10_000).catch(() => undefined);
    expect((await t.db.delivery.findFirstOrThrow()).status).toBe('in_flight');

    await t.pool.query(`UPDATE deliveries SET lease_until = now() - interval '1 second'`);
    target.respondWithSequence([200]);
    await startServer();
    await waitFor(async () => (await t.db.delivery.findFirstOrThrow()).status === 'delivered');
    expect(await t.db.delivery.findFirstOrThrow()).toMatchObject({ attempts: 2 });
  });

  it('serves the admin API and ingest from the same process when the worker is disabled', async () => {
    const port = await startServer({ WORKER_ENABLED: 'false' });
    expect(await sendWebhook(port, 'sig-4')).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    expect(target.requests).toHaveLength(0);
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { authorization: `Bearer ${TEST_SECRETS.admin}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met in time\n${logs}`);
}
