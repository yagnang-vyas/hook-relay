// Mirrors src/delivery/backoff.ts so the simulator displays the same retry schedule as the
// service. Kept as a copy on purpose: the playground must not import server code.

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

const MAX_EXPONENT = 30;

/** Upper bound of the delay after `attempt` failed attempts (1-based). */
export function backoffCeilingMs(attempt: number, config: BackoffConfig): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), MAX_EXPONENT);
  return Math.min(config.maxMs, config.baseMs * 2 ** exponent);
}

/** Full jitter: uniformly random in [0, ceiling]. */
export function computeBackoffMs(
  attempt: number,
  config: BackoffConfig,
  random: () => number,
): number {
  return Math.floor(random() * (backoffCeilingMs(attempt, config) + 1));
}

/** Small deterministic PRNG so a given seed always yields the same simulated jitter. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
