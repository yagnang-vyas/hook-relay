export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

/** Largest exponent applied before the cap; keeps `2 ** n` far from overflowing a double. */
const MAX_EXPONENT = 30;

/** Upper bound of the delay after `attempt` failed attempts (1-based): min(maxMs, baseMs * 2^(attempt-1)). */
export function backoffCeilingMs(attempt: number, config: BackoffConfig): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), MAX_EXPONENT);
  return Math.min(config.maxMs, config.baseMs * 2 ** exponent);
}

/**
 * Exponential backoff with full jitter: a uniformly random delay in [0, ceiling]. `random` must
 * return values in [0, 1) and is injectable so tests can pin the jitter.
 */
export function computeBackoffMs(
  attempt: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, config);
  return Math.floor(random() * (ceiling + 1));
}
