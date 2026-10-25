import { readFileSync } from 'node:fs';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const headerName = z.string().regex(HEADER_NAME, 'must be a valid HTTP header name');
const identifier = z
  .string()
  .regex(IDENTIFIER, 'must be 1-64 characters of letters, digits, "_" or "-"');

const schemeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hmac-sha256'),
    header: headerName,
    format: z.enum(['sha256=hex', 'hex', 'base64']),
  }),
  z.strictObject({
    type: z.literal('timestamped-hmac-sha256'),
    header: headerName,
    toleranceSeconds: z.number().int().min(1).max(86_400).default(300),
  }),
]);

const sourceSchema = z.strictObject({
  id: identifier,
  secretEnv: z.string().regex(ENV_NAME, 'must be an environment variable name'),
  scheme: schemeSchema,
  deliveryIdHeader: headerName.optional(),
  targets: z.array(identifier).min(1),
});

const targetSchema = z.strictObject({
  id: identifier,
  url: z.url(),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  maxAttempts: z.number().int().min(1).max(50).default(8),
  backoff: z
    .strictObject({
      baseMs: z.number().int().min(1).max(3_600_000).default(2_000),
      maxMs: z.number().int().min(1).max(86_400_000).default(3_600_000),
    })
    .default({ baseMs: 2_000, maxMs: 3_600_000 }),
});

const fileSchema = z.strictObject({
  sources: z.array(sourceSchema).min(1),
  targets: z.array(targetSchema).min(1),
  network: z
    .strictObject({
      allowPrivateTargets: z.array(z.string().min(1)).default([]),
      allowHttp: z.boolean().default(false),
    })
    .default({ allowPrivateTargets: [], allowHttp: false }),
  maxBodyBytes: z.number().int().min(1).max(26_214_400).default(1_048_576),
  retentionDays: z.number().int().min(1).max(3650).default(14),
});

export type SchemeConfig = z.infer<typeof schemeSchema>;

export interface SourceConfig {
  id: string;
  /** All accepted secrets (more than one during rotation). */
  secrets: Buffer[];
  scheme: SchemeConfig;
  deliveryIdHeader: string | undefined;
  targets: string[];
}

export interface TargetConfig {
  id: string;
  url: string;
  timeoutMs: number;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number };
}

export interface NetworkConfig {
  /** Lower-cased hostnames that may resolve to private addresses. */
  allowPrivateTargets: ReadonlySet<string>;
  allowHttp: boolean;
}

export interface RelayConfig {
  sources: ReadonlyMap<string, SourceConfig>;
  targets: ReadonlyMap<string, TargetConfig>;
  network: NetworkConfig;
  maxBodyBytes: number;
  retentionDays: number;
}

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a lower-case PostgreSQL identifier')
    .optional(),
  ADMIN_API_KEY: z.string().min(16, 'must be at least 16 characters'),
  RELAY_SIGNING_SECRET: z.string().min(16, 'must be at least 16 characters'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_ENABLED: booleanString.default(true),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
  LEASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(300_000).default(15_000),
  CONFIG_PATH: z.string().min(1).default('hookrelay.config.json'),
  MIGRATIONS_DIR: z.string().min(1).default('prisma/migrations'),
});

export interface EnvConfig {
  databaseUrl: string;
  /** Schema holding HookRelay's tables; the connection's default (usually public) when unset. */
  databaseSchema: string | undefined;
  adminApiKey: string;
  relaySigningSecret: string;
  port: number;
  host: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  workerEnabled: boolean;
  workerBatchSize: number;
  workerPollIntervalMs: number;
  leaseSeconds: number;
  shutdownGraceMs: number;
  configPath: string;
  migrationsDir: string;
}

export interface Config {
  env: EnvConfig;
  relay: RelayConfig;
}

type Environment = Record<string, string | undefined>;

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${prefix}${where}: ${issue.message}`;
  });
}

export function parseEnv(env: Environment): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatIssues('environment ', result.error));
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    databaseSchema: e.DATABASE_SCHEMA,
    adminApiKey: e.ADMIN_API_KEY,
    relaySigningSecret: e.RELAY_SIGNING_SECRET,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    workerEnabled: e.WORKER_ENABLED,
    workerBatchSize: e.WORKER_BATCH_SIZE,
    workerPollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: e.LEASE_SECONDS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    configPath: e.CONFIG_PATH,
    migrationsDir: e.MIGRATIONS_DIR,
  };
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function readSecrets(secretEnv: string, env: Environment): Buffer[] {
  const raw = env[secretEnv];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Buffer.from(s, 'utf8'));
}

/**
 * Validates the relay config document and resolves secrets from the environment.
 * Collects every problem so that an operator can fix them in one pass.
 */
export function parseRelayConfig(
  document: unknown,
  env: Environment,
  leaseSeconds: number,
): RelayConfig {
  const parsed = fileSchema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigError(formatIssues('', parsed.error));
  }
  const file = parsed.data;
  const problems: string[] = [];

  for (const id of findDuplicates(file.sources.map((s) => s.id))) {
    problems.push(`duplicate source id "${id}"`);
  }
  for (const id of findDuplicates(file.targets.map((t) => t.id))) {
    problems.push(`duplicate target id "${id}"`);
  }

  const targetIds = new Set(file.targets.map((t) => t.id));
  const allowPrivate = new Set(file.network.allowPrivateTargets.map((h) => h.toLowerCase()));

  const sources = new Map<string, SourceConfig>();
  for (const s of file.sources) {
    const secrets = readSecrets(s.secretEnv, env);
    if (secrets.length === 0) {
      problems.push(`source "${s.id}": environment variable ${s.secretEnv} is not set or is empty`);
    }
    for (const t of s.targets) {
      if (!targetIds.has(t)) problems.push(`source "${s.id}" references unknown target "${t}"`);
    }
    if (findDuplicates(s.targets).length > 0) {
      problems.push(`source "${s.id}" lists a target more than once`);
    }
    sources.set(s.id, {
      id: s.id,
      secrets,
      scheme: s.scheme,
      deliveryIdHeader: s.deliveryIdHeader,
      targets: s.targets,
    });
  }

  const targets = new Map<string, TargetConfig>();
  for (const t of file.targets) {
    const url = new URL(t.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`target "${t.id}": url must use http or https`);
    } else if (url.protocol === 'http:' && !file.network.allowHttp) {
      problems.push(`target "${t.id}": http urls require network.allowHttp to be true`);
    }
    if (url.username !== '' || url.password !== '') {
      problems.push(`target "${t.id}": url must not contain credentials`);
    }
    if (t.backoff.maxMs < t.backoff.baseMs) {
      problems.push(`target "${t.id}": backoff.maxMs must be >= backoff.baseMs`);
    }
    if (t.timeoutMs + 5_000 >= leaseSeconds * 1000) {
      problems.push(
        `target "${t.id}": timeoutMs (${t.timeoutMs}) must be at least 5s shorter than LEASE_SECONDS (${leaseSeconds}s)`,
      );
    }
    targets.set(t.id, {
      id: t.id,
      url: url.toString(),
      timeoutMs: t.timeoutMs,
      maxAttempts: t.maxAttempts,
      backoff: t.backoff,
    });
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    sources,
    targets,
    network: { allowPrivateTargets: allowPrivate, allowHttp: file.network.allowHttp },
    maxBodyBytes: file.maxBodyBytes,
    retentionDays: file.retentionDays,
  };
}

export function loadConfig(env: Environment = process.env): Config {
  const envConfig = parseEnv(env);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(envConfig.configPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError([`cannot read config file ${envConfig.configPath}: ${reason}`]);
  }
  return {
    env: envConfig,
    relay: parseRelayConfig(document, env, envConfig.leaseSeconds),
  };
}
