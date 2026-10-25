import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { parseEnv, parseRelayConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export interface CapturedLogger {
  logger: Logger;
  /** Everything written so far, as one string. */
  output: () => string;
  records: () => Record<string, unknown>[];
}

export function captureLogger(level = 'trace'): CapturedLogger {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return {
    logger: createLogger(level, sink),
    output: () => chunks.join(''),
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export const TEST_SECRETS = {
  github: 'github-test-secret',
  paymentsOld: 'payments-old-secret',
  paymentsNew: 'payments-new-secret',
  admin: 'admin-test-key-0123456789',
  relay: 'relay-signing-secret-0123456789',
} as const;

export interface TestConfigOptions {
  ordersUrl?: string;
  billingUrl?: string;
  maxBodyBytes?: number;
  retentionDays?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  backoff?: { baseMs: number; maxMs: number };
  allowPrivateTargets?: string[];
  allowHttp?: boolean;
  workerBatchSize?: number;
}

/** A realistic two-source, three-target configuration built through the real validators. */
export function testConfig(options: TestConfigOptions = {}): Config {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const env = parseEnv({
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://unused',
    ADMIN_API_KEY: TEST_SECRETS.admin,
    RELAY_SIGNING_SECRET: TEST_SECRETS.relay,
    LEASE_SECONDS: String(leaseSeconds),
    LOG_LEVEL: 'silent',
    WORKER_POLL_INTERVAL_MS: '20',
    WORKER_BATCH_SIZE: String(options.workerBatchSize ?? 10),
    MIGRATIONS_DIR: 'prisma/migrations',
  });
  const target = (id: string, url: string) => ({
    id,
    url,
    timeoutMs: options.timeoutMs ?? 2_000,
    maxAttempts: options.maxAttempts ?? 3,
    backoff: options.backoff ?? { baseMs: 10, maxMs: 100 },
  });
  const relay = parseRelayConfig(
    {
      sources: [
        {
          id: 'github',
          secretEnv: 'T_GITHUB',
          scheme: { type: 'hmac-sha256', header: 'X-Hub-Signature-256', format: 'sha256=hex' },
          deliveryIdHeader: 'X-GitHub-Delivery',
          targets: ['orders'],
        },
        {
          id: 'payments',
          secretEnv: 'T_PAYMENTS',
          scheme: { type: 'timestamped-hmac-sha256', header: 'X-Signature', toleranceSeconds: 300 },
          deliveryIdHeader: 'X-Event-Id',
          targets: ['billing', 'orders'],
        },
        {
          id: 'plain',
          secretEnv: 'T_GITHUB',
          scheme: { type: 'hmac-sha256', header: 'X-Sig', format: 'hex' },
          targets: ['orders'],
        },
      ],
      targets: [
        target('orders', options.ordersUrl ?? 'http://127.0.0.1:9/hook'),
        target('billing', options.billingUrl ?? 'http://127.0.0.1:9/billing'),
      ],
      network: {
        allowPrivateTargets: options.allowPrivateTargets ?? ['127.0.0.1', 'localhost'],
        allowHttp: options.allowHttp ?? true,
      },
      maxBodyBytes: options.maxBodyBytes ?? 1_048_576,
      retentionDays: options.retentionDays ?? 14,
    },
    {
      T_GITHUB: TEST_SECRETS.github,
      T_PAYMENTS: `${TEST_SECRETS.paymentsNew},${TEST_SECRETS.paymentsOld}`,
    },
    leaseSeconds,
  );
  return { env, relay };
}
