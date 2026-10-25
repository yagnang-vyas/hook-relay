import { describe, expect, it } from 'vitest';
import { serializeError } from '../../src/logger.js';
import { captureLogger } from '../helpers.js';

describe('logger redaction', () => {
  it('masks sensitive keys at any depth we configure', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        authorization: 'Bearer top-secret',
        headers: { authorization: 'Bearer top-secret', 'x-hub-signature-256': 'sha256=abc' },
        req: { headers: { cookie: 'session=abc' } },
        nested: { signature: 'sig-value', secret: 'shh', body: 'payload-body' },
        adminApiKey: 'admin-key',
      },
      'hello',
    );
    const out = output();
    for (const leaked of [
      'top-secret',
      'sha256=abc',
      'session=abc',
      'sig-value',
      'shh',
      'payload-body',
      'admin-key',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[REDACTED]');
  });
});

describe('serializeError', () => {
  it('keeps message and stack for ordinary errors', () => {
    const out = serializeError(new TypeError('boom'));
    expect(out).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(out['stack']).toBeTypeOf('string');
  });

  it('drops the message of database client errors, which can echo payloads', () => {
    class PrismaClientKnownRequestError extends Error {
      override name = 'PrismaClientKnownRequestError';
      code = 'P2002';
    }
    const out = serializeError(
      new PrismaClientKnownRequestError('args: {"body":"secret payload"}'),
    );
    expect(out).toEqual({ type: 'PrismaClientKnownRequestError', code: 'P2002' });
  });

  it('handles non-error values', () => {
    expect(serializeError('x')).toEqual({ type: 'string' });
  });

  it('truncates long messages', () => {
    const out = serializeError(new Error('x'.repeat(1000)));
    expect((out['message'] as string).length).toBe(300);
  });
});
