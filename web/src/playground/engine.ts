// Deterministic delivery lifecycle simulation. Pure functions with explicit inputs and outputs;
// no network, no timers, no imports from the service. Decision rules mirror src/delivery/worker.ts
// and src/delivery/forward.ts (2xx delivers, 4xx other than 408/429 is permanent, everything
// else retries until the budget is spent). Timing is virtual and labelled illustrative.

import { computeBackoffMs, type BackoffConfig } from './backoff';

export type DeliveryStatus = 'pending' | 'in_flight' | 'retrying' | 'delivered' | 'dead';
export type DeadReason = 'permanent_status' | 'max_attempts';

export type TargetResponse =
  { kind: 'status'; code: number } | { kind: 'timeout' } | { kind: 'network_error' };

export interface TargetConfig {
  id: string;
  maxAttempts: number;
  backoff: BackoffConfig;
  timeoutMs: number;
}

/** Defaults taken from hookrelay.config.example.json. */
export const DEFAULT_TARGET: TargetConfig = {
  id: 'orders-service',
  maxAttempts: 8,
  backoff: { baseMs: 2000, maxMs: 3_600_000 },
  timeoutMs: 5000,
};

export interface SimAttempt {
  attemptNumber: number;
  startedAtMs: number;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
}

export interface SimDelivery {
  id: string;
  eventId: string;
  targetId: string;
  status: DeliveryStatus;
  attempts: number;
  attemptsBase: number;
  nextAttemptAtMs: number;
  lastStatus: number | null;
  lastError: string | null;
  deadReason: DeadReason | null;
  createdAtMs: number;
  deliveredAtMs: number | null;
  attemptHistory: SimAttempt[];
}

export type StepKind =
  | 'accepted'
  | 'persisted'
  | 'delivery_created'
  | 'claimed'
  | 'response'
  | 'retry_scheduled'
  | 'delivered'
  | 'dead'
  | 'manual_retry'
  | 'replay';

export interface TimelineStep {
  atMs: number;
  kind: StepKind;
  title: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warn' | 'danger' | 'info';
}

export type Classification = 'delivered' | 'permanent' | 'retryable';

export function classify(response: TargetResponse): Classification {
  if (response.kind !== 'status') return 'retryable';
  const c = response.code;
  if (c >= 200 && c < 300) return 'delivered';
  if (c >= 400 && c < 500 && c !== 408 && c !== 429) return 'permanent';
  return 'retryable';
}

function describe(response: TargetResponse): {
  statusCode: number | null;
  error: string | null;
  durationMs: number;
} {
  switch (response.kind) {
    case 'status':
      return {
        statusCode: response.code,
        error:
          classify(response) === 'delivered' ? null : `target responded with HTTP ${response.code}`,
        durationMs: 120,
      };
    case 'timeout':
      return { statusCode: null, error: 'request timed out', durationMs: 5000 };
    case 'network_error':
      return { statusCode: null, error: 'connection refused', durationMs: 15 };
  }
}

export function responseLabel(r: TargetResponse): string {
  return r.kind === 'status'
    ? `HTTP ${r.code}`
    : r.kind === 'timeout'
      ? 'timeout'
      : 'connection error';
}

export function newDelivery(
  id: string,
  eventId: string,
  targetId: string,
  nowMs: number,
): SimDelivery {
  return {
    id,
    eventId,
    targetId,
    status: 'pending',
    attempts: 0,
    attemptsBase: 0,
    nextAttemptAtMs: nowMs,
    lastStatus: null,
    lastError: null,
    deadReason: null,
    createdAtMs: nowMs,
    deliveredAtMs: null,
    attemptHistory: [],
  };
}

/** One worker attempt: claim, call the target, record the outcome and decide what happens next. */
export function runAttempt(
  delivery: SimDelivery,
  response: TargetResponse,
  target: TargetConfig,
  random: () => number,
  nowMs: number,
): { delivery: SimDelivery; steps: TimelineStep[] } {
  const attempts = delivery.attempts + 1;
  const used = attempts - delivery.attemptsBase;
  const outcome = describe(response);
  const finishedAt = nowMs + outcome.durationMs;
  const steps: TimelineStep[] = [
    {
      atMs: nowMs,
      kind: 'claimed',
      title: `Worker attempt ${attempts}`,
      detail: `Delivery claimed (in_flight) and POSTed to ${target.id}. This is attempt ${used} of ${target.maxAttempts} in the current retry budget.`,
      tone: 'info',
    },
    {
      atMs: finishedAt,
      kind: 'response',
      title: `Simulated target response: ${responseLabel(response)}`,
      detail: `Classified as ${classify(response)}. ${outcome.error ?? 'The target acknowledged the request.'}`,
      tone: classify(response) === 'delivered' ? 'success' : 'warn',
    },
  ];
  const next: SimDelivery = {
    ...delivery,
    attempts,
    lastStatus: outcome.statusCode,
    lastError: outcome.error,
    attemptHistory: [
      ...delivery.attemptHistory,
      {
        attemptNumber: attempts,
        startedAtMs: nowMs,
        durationMs: outcome.durationMs,
        statusCode: outcome.statusCode,
        error: outcome.error,
      },
    ],
  };

  const kind = classify(response);
  if (kind === 'delivered') {
    next.status = 'delivered';
    next.deliveredAtMs = finishedAt;
    next.deadReason = null;
    steps.push({
      atMs: finishedAt,
      kind: 'delivered',
      title: 'Delivery succeeded',
      detail:
        'Marked delivered. The target must still deduplicate on X-HookRelay-Event-Id (at-least-once).',
      tone: 'success',
    });
  } else if (kind === 'permanent') {
    next.status = 'dead';
    next.deadReason = 'permanent_status';
    steps.push({
      atMs: finishedAt,
      kind: 'dead',
      title: 'Dead-lettered: permanent client error',
      detail: `HTTP ${outcome.statusCode} is a non-retryable 4xx (only 408 and 429 are retried). No further attempts.`,
      tone: 'danger',
    });
  } else if (used >= target.maxAttempts) {
    next.status = 'dead';
    next.deadReason = 'max_attempts';
    steps.push({
      atMs: finishedAt,
      kind: 'dead',
      title: 'Dead-lettered: retry budget exhausted',
      detail: `${used} of ${target.maxAttempts} attempts used. The delivery stays in the dead letter queue until an operator retries it.`,
      tone: 'danger',
    });
  } else {
    const delay = computeBackoffMs(used, target.backoff, random);
    next.status = 'retrying';
    next.nextAttemptAtMs = finishedAt + delay;
    steps.push({
      atMs: finishedAt,
      kind: 'retry_scheduled',
      title: `Retry scheduled in ${(delay / 1000).toFixed(1)} s`,
      detail: `Exponential backoff with full jitter: uniform random in [0, min(${target.backoff.maxMs} ms, ${target.backoff.baseMs} ms × 2^${used - 1})]. Jitter here is seeded and illustrative.`,
      tone: 'warn',
    });
  }
  return { delivery: next, steps };
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  /** Response of the n-th attempt of this run (1-based). */
  responseFor: (attempt: number) => TargetResponse;
  /** Runs to the dead state first and then waits for the operator's manual retry. */
  stopsAtDead?: boolean;
  /** Overrides the target's retry budget for this scenario. */
  maxAttempts?: number;
}

const status = (code: number): TargetResponse => ({ kind: 'status', code });

export const SCENARIOS: Scenario[] = [
  {
    id: 'immediate_success',
    label: 'Immediate success',
    description: 'The target answers 200 on the first attempt.',
    responseFor: () => status(200),
  },
  {
    id: 'transient_503',
    label: 'Temporary 503, then success',
    description: 'The first attempt gets 503; the retry succeeds.',
    responseFor: (n) => (n === 1 ? status(503) : status(200)),
  },
  {
    id: 'timeout_recovery',
    label: 'Timeout, then recovery',
    description: 'The first attempt times out; the retry succeeds.',
    responseFor: (n) => (n === 1 ? { kind: 'timeout' } : status(200)),
  },
  {
    id: 'repeated_5xx',
    label: 'Repeated server errors, then success',
    description: 'Three 5xx responses in a row; the fourth attempt succeeds.',
    responseFor: (n) => (n < 4 ? status([500, 502, 503][n - 1] ?? 500) : status(200)),
  },
  {
    id: 'exhausted',
    label: 'Exhausted retry budget',
    description: 'The target keeps answering 503 until the retry budget is spent.',
    responseFor: () => status(503),
  },
  {
    id: 'permanent_4xx',
    label: 'Immediate non-retryable client error',
    description: 'The target answers 400. 4xx other than 408 and 429 is never retried.',
    responseFor: () => status(400),
  },
  {
    id: 'manual_retry',
    label: 'Manual retry of a dead delivery',
    description:
      'Fails until dead-lettered (budget of 3), then waits for you to trigger a manual retry.',
    responseFor: () => status(500),
    stopsAtDead: true,
    maxAttempts: 3,
  },
];

export function scenarioById(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? (SCENARIOS[0] as Scenario);
}

/** Runs attempts until the delivery is delivered or dead. */
export function runToCompletion(
  delivery: SimDelivery,
  responseFor: (attemptInRun: number) => TargetResponse,
  target: TargetConfig,
  random: () => number,
  startMs: number,
): { delivery: SimDelivery; steps: TimelineStep[] } {
  let current = delivery;
  let now = Math.max(startMs, delivery.nextAttemptAtMs);
  const steps: TimelineStep[] = [];
  let n = 0;
  // Bounded by the retry budget; the extra guard protects against a nonsensical configuration.
  while (current.status !== 'delivered' && current.status !== 'dead' && n < 1000) {
    n++;
    const res = runAttempt(current, responseFor(n), target, random, now);
    steps.push(...res.steps);
    current = res.delivery;
    now = current.status === 'retrying' ? current.nextAttemptAtMs : now;
  }
  return { delivery: current, steps };
}

/** Mirrors POST /api/deliveries/:id/retry: fresh budget, due immediately, history continues. */
export function manualRetry(
  delivery: SimDelivery,
  nowMs: number,
): { delivery: SimDelivery; steps: TimelineStep[] } | undefined {
  if (delivery.status !== 'dead') return undefined;
  return {
    delivery: {
      ...delivery,
      status: 'pending',
      attemptsBase: delivery.attempts,
      nextAttemptAtMs: nowMs,
      deadReason: null,
    },
    steps: [
      {
        atMs: nowMs,
        kind: 'manual_retry',
        title: 'Operator retry (simulated POST /api/deliveries/:id/retry)',
        detail: `Delivery moved back to pending with a fresh retry budget. Lifetime attempts stay at ${delivery.attempts}; numbering and history continue.`,
        tone: 'info',
      },
    ],
  };
}

export interface ScenarioRun {
  delivery: SimDelivery;
  steps: TimelineStep[];
}

/** Everything from ingest acknowledgement to the final delivery state, for the standalone lab. */
export function simulateScenario(
  scenario: Scenario,
  target: TargetConfig,
  random: () => number,
  ids: { eventId: string; deliveryId: string },
  startMs = 0,
): ScenarioRun {
  const effective = { ...target, maxAttempts: scenario.maxAttempts ?? target.maxAttempts };
  const created = newDelivery(ids.deliveryId, ids.eventId, effective.id, startMs);
  const steps: TimelineStep[] = [
    {
      atMs: startMs,
      kind: 'accepted',
      title: 'Event accepted (simulated 202)',
      detail: 'Signature verified over the raw body and the delivery ID was new.',
      tone: 'success',
    },
    {
      atMs: startMs,
      kind: 'persisted',
      title: 'Event persisted (simulated)',
      detail:
        'In the real service the event and one pending delivery per target are written in a single PostgreSQL transaction before the 202. Nothing is written here.',
      tone: 'neutral',
    },
    {
      atMs: startMs,
      kind: 'delivery_created',
      title: `Delivery created for ${effective.id}`,
      detail: 'Status pending, due immediately.',
      tone: 'neutral',
    },
  ];
  const result = runToCompletion(created, scenario.responseFor, effective, random, startMs);
  return { delivery: result.delivery, steps: [...steps, ...result.steps] };
}

export function formatVirtualTime(ms: number): string {
  return `T+${(ms / 1000).toFixed(1)}s`;
}
