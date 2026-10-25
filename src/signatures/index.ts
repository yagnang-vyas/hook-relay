import type { SchemeConfig } from '../config.js';
import { verifyHmac, verifyTimestampedHmac, type VerifyResult } from './schemes.js';

export type { FailureReason, VerifyResult } from './schemes.js';

export interface VerifyInput {
  scheme: SchemeConfig;
  /** Every currently accepted secret; a signature made with any of them is valid. */
  secrets: readonly Buffer[];
  /** Value of the scheme's signature header, if the request carried one. */
  headerValue: string | undefined;
  /** The exact bytes received on the wire. */
  body: Buffer;
  /** Current time in milliseconds since the epoch (injected for testability). */
  nowMs: number;
}

/** Pure and total: any input yields a result; nothing here throws on hostile headers. */
export function verifySignature(input: VerifyInput): VerifyResult {
  const { scheme, secrets, headerValue, body, nowMs } = input;
  switch (scheme.type) {
    case 'hmac-sha256':
      return verifyHmac(scheme.format, headerValue, secrets, body);
    case 'timestamped-hmac-sha256':
      return verifyTimestampedHmac(
        headerValue,
        secrets,
        body,
        scheme.toleranceSeconds,
        Math.floor(nowMs / 1000),
      );
  }
}
