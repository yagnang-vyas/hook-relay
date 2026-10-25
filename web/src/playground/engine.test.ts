import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, computeBackoffMs, seededRandom } from './backoff';
import {
  DEFAULT_TARGET,
  SCENARIOS,
  classify,
  manualRetry,
  newDelivery,
  runAttempt,
  runToCompletion,
  scenarioById,
  simulateScenario,
} from './engine';

const run = (id: string, over: Partial<typeof DEFAULT_TARGET> = {}) =>
  simulateScenario(scenarioById(id), { ...DEFAULT_TARGET, ...over }, seededRandom(1), {
    eventId: 'e',
    deliveryId: 'd',
  });

describe('backoff (mirror of the service formula)', () => {
  it('caps the ceiling at maxMs and doubles per attempt', () => {
    const cfg = { baseMs: 2000, maxMs: 3_600_000 };
    expect([1, 2, 3, 4].map((n) => backoffCeilingMs(n, cfg))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffCeilingMs(40, cfg)).toBe(3_600_000);
  });
  it('full jitter stays within [0, ceiling]', () => {
    const cfg = { baseMs: 1000, maxMs: 10_000 };
    expect(computeBackoffMs(3, cfg, () => 0)).toBe(0);
    expect(computeBackoffMs(3, cfg, () => 0.999999)).toBeLessThanOrEqual(4000);
  });
  it('is deterministic for a seed', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('classification matches the worker rules', () => {
  it.each([
    [{ kind: 'status', code: 200 }, 'delivered'],
    [{ kind: 'status', code: 204 }, 'delivered'],
    [{ kind: 'status', code: 400 }, 'permanent'],
    [{ kind: 'status', code: 404 }, 'permanent'],
    [{ kind: 'status', code: 408 }, 'retryable'],
    [{ kind: 'status', code: 429 }, 'retryable'],
    [{ kind: 'status', code: 301 }, 'retryable'],
    [{ kind: 'status', code: 503 }, 'retryable'],
    [{ kind: 'timeout' }, 'retryable'],
    [{ kind: 'network_error' }, 'retryable'],
  ] as const)('%j is %s', (response, expected) => {
    expect(classify(response)).toBe(expected);
  });
});

describe('scenarios', () => {
  it('delivers immediately', () => {
    const r = run('immediate_success');
    expect(r.delivery).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(r.steps.map((s) => s.kind)).toEqual([
      'accepted',
      'persisted',
      'delivery_created',
      'claimed',
      'response',
      'delivered',
    ]);
  });

  it('retries a 503 and then succeeds', () => {
    const r = run('transient_503');
    expect(r.delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(r.steps.some((s) => s.kind === 'retry_scheduled')).toBe(true);
    expect(r.delivery.attemptHistory.map((a) => a.statusCode)).toEqual([503, 200]);
  });

  it('recovers after a timeout', () => {
    const r = run('timeout_recovery');
    expect(r.delivery.attemptHistory.map((a) => [a.statusCode, a.error])).toEqual([
      [null, 'request timed out'],
      [200, null],
    ]);
    expect(r.delivery.status).toBe('delivered');
  });

  it('recovers after repeated server errors', () => {
    const r = run('repeated_5xx');
    expect(r.delivery.attempts).toBe(4);
    expect(r.delivery.status).toBe('delivered');
  });

  it('dead-letters when the retry budget is exhausted', () => {
    const r = run('exhausted', { maxAttempts: 4 });
    expect(r.delivery).toMatchObject({ status: 'dead', deadReason: 'max_attempts', attempts: 4 });
    expect(r.steps.filter((s) => s.kind === 'retry_scheduled')).toHaveLength(3);
    expect(r.steps.at(-1)?.kind).toBe('dead');
  });

  it('dead-letters a non-retryable client error on the first attempt', () => {
    const r = run('permanent_4xx');
    expect(r.delivery).toMatchObject({
      status: 'dead',
      deadReason: 'permanent_status',
      attempts: 1,
    });
    expect(r.steps.some((s) => s.kind === 'retry_scheduled')).toBe(false);
  });

  it('retry delays never exceed the documented ceiling', () => {
    const r = run('exhausted', { maxAttempts: 8 });
    const times = r.delivery.attemptHistory.map((a) => a.startedAtMs);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - (times[i - 1]! + r.delivery.attemptHistory[i - 1]!.durationMs);
      expect(gap).toBeLessThanOrEqual(backoffCeilingMs(i, DEFAULT_TARGET.backoff));
    }
  });

  it('is deterministic for the same seed', () => {
    expect(run('exhausted')).toEqual(run('exhausted'));
  });

  it('has every documented scenario', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      'immediate_success',
      'transient_503',
      'timeout_recovery',
      'repeated_5xx',
      'exhausted',
      'permanent_4xx',
      'manual_retry',
    ]);
  });
});

describe('manual retry', () => {
  const dead = () => run('manual_retry').delivery;

  it('only applies to dead deliveries', () => {
    expect(manualRetry(newDelivery('d', 'e', 't', 0), 0)).toBeUndefined();
  });

  it('gives a fresh budget and continues numbering', () => {
    const d = dead();
    expect(d).toMatchObject({ status: 'dead', attempts: 3 });
    const retried = manualRetry(d, 1000)!;
    expect(retried.delivery).toMatchObject({
      status: 'pending',
      attemptsBase: 3,
      attempts: 3,
      deadReason: null,
    });
    const done = runToCompletion(
      retried.delivery,
      () => ({ kind: 'status', code: 200 }),
      { ...DEFAULT_TARGET, maxAttempts: 3 },
      seededRandom(1),
      1000,
    );
    expect(done.delivery).toMatchObject({ status: 'delivered', attempts: 4 });
    expect(done.delivery.attemptHistory.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
  });

  it('can fail again and exhaust the new budget', () => {
    const retried = manualRetry(dead(), 0)!;
    const done = runToCompletion(
      retried.delivery,
      () => ({ kind: 'status', code: 503 }),
      { ...DEFAULT_TARGET, maxAttempts: 3 },
      seededRandom(1),
      0,
    );
    expect(done.delivery).toMatchObject({
      status: 'dead',
      attempts: 6,
      deadReason: 'max_attempts',
    });
  });
});

describe('runAttempt', () => {
  it('does not mutate its input', () => {
    const d = newDelivery('d', 'e', 't', 0);
    const frozen = structuredClone(d);
    runAttempt(d, { kind: 'status', code: 500 }, DEFAULT_TARGET, seededRandom(1), 0);
    expect(d).toEqual(frozen);
  });
});
