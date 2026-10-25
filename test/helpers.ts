import { Writable } from 'node:stream';
import type { Logger } from 'pino';
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
