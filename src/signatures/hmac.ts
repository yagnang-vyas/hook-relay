import { createHmac, timingSafeEqual } from 'node:crypto';

export const SHA256_BYTES = 32;

export function hmacSha256(secret: Buffer, ...chunks: (Buffer | string)[]): Buffer {
  const mac = createHmac('sha256', secret);
  for (const chunk of chunks) mac.update(chunk);
  return mac.digest();
}

/** Length-checked constant-time comparison; never throws on length mismatch. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True if `provided` equals any of `candidates`. Every candidate is compared so that the
 * time taken does not reveal which (if any) secret matched.
 */
export function matchesAny(candidates: readonly Buffer[], provided: Buffer): boolean {
  let matched = false;
  for (const candidate of candidates) {
    if (constantTimeEqual(candidate, provided)) matched = true;
  }
  return matched;
}
