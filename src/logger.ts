import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Defense in depth: code must never hand secrets, signatures or payloads to the
 * logger, but if a structured object containing one slips through, it is masked.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'signature',
  'secret',
  'secrets',
  'body',
  'adminApiKey',
  'relaySigningSecret',
  'headers.authorization',
  'headers.cookie',
  'headers["x-hub-signature-256"]',
  'headers["x-signature"]',
  'headers["x-hookrelay-signature"]',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  '*.cookie',
  '*.signature',
  '*.secret',
  '*.secrets',
  '*.body',
  '*.adminApiKey',
  '*.relaySigningSecret',
];

/**
 * Unexpected errors can carry sensitive data in their message (Prisma echoes the
 * arguments of a failed call, which include webhook payloads), so those are
 * reduced to their type and code.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const code = (err as { code?: unknown }).code;
  const base: Record<string, unknown> = { type: err.name };
  if (typeof code === 'string' || typeof code === 'number') base['code'] = code;
  if (err.name.startsWith('PrismaClient') || err.name === 'DriverAdapterError') return base;
  base['message'] = err.message.slice(0, 300);
  if (err.stack !== undefined) base['stack'] = err.stack;
  return base;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'hook-relay' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { err: serializeError },
    },
    destination,
  );
}

export type { Logger };
