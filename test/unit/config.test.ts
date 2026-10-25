import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv, parseRelayConfig } from '../../src/config.js';

const baseEnv = {
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  PAYMENTS_WEBHOOK_SECRET: 'old-secret, new-secret',
};

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sources: [
      {
        id: 'github',
        secretEnv: 'GITHUB_WEBHOOK_SECRET',
        scheme: { type: 'hmac-sha256', header: 'X-Hub-Signature-256', format: 'sha256=hex' },
        deliveryIdHeader: 'X-GitHub-Delivery',
        targets: ['orders'],
      },
    ],
    targets: [{ id: 'orders', url: 'https://orders.example.com/hook' }],
    ...overrides,
  };
}

function problems(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected a ConfigError');
}

describe('parseRelayConfig', () => {
  it('applies defaults and resolves secrets', () => {
    const cfg = parseRelayConfig(document(), baseEnv, 60);
    const target = cfg.targets.get('orders');
    expect(target).toMatchObject({
      timeoutMs: 10_000,
      maxAttempts: 8,
      backoff: { baseMs: 2_000, maxMs: 3_600_000 },
    });
    expect(cfg.maxBodyBytes).toBe(1_048_576);
    expect(cfg.retentionDays).toBe(14);
    expect(cfg.network.allowHttp).toBe(false);
    expect(cfg.sources.get('github')?.secrets).toEqual([Buffer.from('gh-secret')]);
  });

  it('supports comma-separated secrets for rotation', () => {
    const doc = document({
      sources: [
        {
          id: 'payments',
          secretEnv: 'PAYMENTS_WEBHOOK_SECRET',
          scheme: { type: 'timestamped-hmac-sha256', header: 'X-Signature' },
          targets: ['orders'],
        },
      ],
    });
    const cfg = parseRelayConfig(doc, baseEnv, 60);
    expect(cfg.sources.get('payments')?.secrets.map(String)).toEqual(['old-secret', 'new-secret']);
    expect(cfg.sources.get('payments')?.scheme).toMatchObject({ toleranceSeconds: 300 });
  });

  it('fails when a secret environment variable is missing or blank', () => {
    expect(problems(() => parseRelayConfig(document(), {}, 60))).toContain(
      'GITHUB_WEBHOOK_SECRET is not set or is empty',
    );
    expect(
      problems(() => parseRelayConfig(document(), { GITHUB_WEBHOOK_SECRET: ' , ' }, 60)),
    ).toContain('GITHUB_WEBHOOK_SECRET is not set or is empty');
  });

  it('fails on unknown target references', () => {
    const doc = document({ targets: [{ id: 'other', url: 'https://x.example.com' }] });
    expect(problems(() => parseRelayConfig(doc, baseEnv, 60))).toContain(
      'source "github" references unknown target "orders"',
    );
  });

  it('fails on duplicate ids', () => {
    const src = (document()['sources'] as unknown[])[0];
    const doc = document({
      sources: [src, src],
      targets: [
        { id: 'orders', url: 'https://a.example.com' },
        { id: 'orders', url: 'https://b.example.com' },
      ],
    });
    const msg = problems(() => parseRelayConfig(doc, baseEnv, 60));
    expect(msg).toContain('duplicate source id "github"');
    expect(msg).toContain('duplicate target id "orders"');
  });

  it('rejects http targets unless allowHttp is set', () => {
    const doc = document({ targets: [{ id: 'orders', url: 'http://orders:8080/x' }] });
    expect(problems(() => parseRelayConfig(doc, baseEnv, 60))).toContain('allowHttp');
    const ok = parseRelayConfig({ ...doc, network: { allowHttp: true } }, baseEnv, 60);
    expect(ok.network.allowHttp).toBe(true);
  });

  it('rejects non-http schemes and embedded credentials', () => {
    const ftp = document({ targets: [{ id: 'orders', url: 'ftp://orders.example.com/x' }] });
    expect(problems(() => parseRelayConfig(ftp, baseEnv, 60))).toContain('http or https');
    const creds = document({
      targets: [{ id: 'orders', url: 'https://u:p@orders.example.com/x' }],
    });
    expect(problems(() => parseRelayConfig(creds, baseEnv, 60))).toContain('credentials');
  });

  it('rejects backoff maxMs below baseMs', () => {
    const doc = document({
      targets: [
        { id: 'orders', url: 'https://x.example.com', backoff: { baseMs: 5000, maxMs: 1000 } },
      ],
    });
    expect(problems(() => parseRelayConfig(doc, baseEnv, 60))).toContain('backoff.maxMs');
  });

  it('requires the target timeout to fit inside the lease', () => {
    const doc = document({
      targets: [{ id: 'orders', url: 'https://x.example.com', timeoutMs: 30_000 }],
    });
    expect(problems(() => parseRelayConfig(doc, baseEnv, 30))).toContain('LEASE_SECONDS');
    expect(() => parseRelayConfig(doc, baseEnv, 60)).not.toThrow();
  });

  it('rejects unknown keys and bad scheme definitions', () => {
    expect(problems(() => parseRelayConfig({ ...document(), extra: 1 }, baseEnv, 60))).toContain(
      'extra',
    );
    const doc = document({
      sources: [
        {
          id: 'github',
          secretEnv: 'GITHUB_WEBHOOK_SECRET',
          scheme: { type: 'hmac-sha256', header: 'bad header', format: 'md5' },
          targets: ['orders'],
        },
      ],
    });
    const msg = problems(() => parseRelayConfig(doc, baseEnv, 60));
    expect(msg).toContain('sources.0.scheme.header');
    expect(msg).toContain('sources.0.scheme.format');
  });

  it('lower-cases the private target allow list', () => {
    const cfg = parseRelayConfig(
      document({ network: { allowPrivateTargets: ['Orders'], allowHttp: false } }),
      baseEnv,
      60,
    );
    expect(cfg.network.allowPrivateTargets.has('orders')).toBe(true);
  });
});

describe('parseEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    ADMIN_API_KEY: 'a'.repeat(16),
    RELAY_SIGNING_SECRET: 'b'.repeat(16),
  };

  it('applies defaults', () => {
    expect(parseEnv(valid)).toMatchObject({
      port: 3000,
      workerEnabled: true,
      workerBatchSize: 10,
      leaseSeconds: 60,
      logLevel: 'info',
    });
  });

  it('parses overrides', () => {
    expect(parseEnv({ ...valid, WORKER_ENABLED: 'false', PORT: '8080' })).toMatchObject({
      workerEnabled: false,
      port: 8080,
    });
  });

  it('reports every missing or weak value', () => {
    const msg = problems(() => parseEnv({ ADMIN_API_KEY: 'short', WORKER_ENABLED: 'yes' }));
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('ADMIN_API_KEY');
    expect(msg).toContain('RELAY_SIGNING_SECRET');
    expect(msg).toContain('WORKER_ENABLED');
  });
});
