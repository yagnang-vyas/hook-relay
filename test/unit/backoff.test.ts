import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, computeBackoffMs } from '../../src/delivery/backoff.js';

const config = { baseMs: 1_000, maxMs: 60_000 };

describe('backoffCeilingMs', () => {
  it('doubles with each attempt', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffCeilingMs(n, config))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
  });

  it('is capped at maxMs', () => {
    expect(backoffCeilingMs(7, config)).toBe(60_000);
    expect(backoffCeilingMs(50, config)).toBe(60_000);
  });

  it('does not overflow for absurd attempt numbers', () => {
    const huge = backoffCeilingMs(1_000_000, { baseMs: 2_000, maxMs: 3_600_000 });
    expect(huge).toBe(3_600_000);
    expect(
      Number.isFinite(backoffCeilingMs(Number.MAX_SAFE_INTEGER, { baseMs: 1, maxMs: 10 ** 12 })),
    ).toBe(true);
  });

  it('treats attempt numbers below one as the first attempt', () => {
    expect(backoffCeilingMs(0, config)).toBe(1_000);
    expect(backoffCeilingMs(-5, config)).toBe(1_000);
  });
});

describe('computeBackoffMs (full jitter)', () => {
  it('spans zero to the ceiling according to the random source', () => {
    expect(computeBackoffMs(3, config, () => 0)).toBe(0);
    expect(computeBackoffMs(3, config, () => 0.5)).toBe(2_000);
    expect(computeBackoffMs(3, config, () => 0.999999999)).toBe(4_000);
  });

  it('never exceeds the ceiling or maxMs', () => {
    for (let attempt = 1; attempt <= 40; attempt++) {
      const ceiling = backoffCeilingMs(attempt, config);
      for (const r of [0, 0.25, 0.5, 0.75, 0.9999999999999999]) {
        const delay = computeBackoffMs(attempt, config, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeLessThanOrEqual(config.maxMs);
      }
    }
  });

  it('returns integers', () => {
    expect(Number.isInteger(computeBackoffMs(2, { baseMs: 7, maxMs: 1_000 }, () => 0.333))).toBe(
      true,
    );
  });

  it('uses Math.random by default and stays in range', () => {
    for (let i = 0; i < 200; i++) {
      const delay = computeBackoffMs(4, config);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });

  it('produces spread, not a constant', () => {
    const values = new Set(Array.from({ length: 50 }, () => computeBackoffMs(5, config)));
    expect(values.size).toBeGreaterThan(10);
  });
});
