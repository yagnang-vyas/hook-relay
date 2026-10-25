import type { Config, TargetConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type { Db } from '../prisma.js';
import {
  claimDue,
  completeAttempt,
  type AttemptRecord,
  type ClaimedDelivery,
  type Completion,
} from '../store/deliveries.js';
import { computeBackoffMs } from './backoff.js';
import type { ForwardOutcome, Forwarder } from './forward.js';
import { recoverExpiredLeases } from './lease.js';

export interface WorkerDeps {
  db: Db;
  config: Config;
  forwarder: Forwarder;
  logger: Logger;
  metrics: Metrics;
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number;
  /** Minimum time between expired-lease sweeps (default 5s); 0 sweeps on every iteration. */
  leaseSweepIntervalMs?: number;
}

/** Default time between expired-lease sweeps, independent of the polling interval. */
const DEFAULT_LEASE_SWEEP_INTERVAL_MS = 5_000;

/** Attempts at writing a delivery outcome before giving up and leaving it to lease recovery. */
const RECORD_TRIES = 3;
const RECORD_RETRY_DELAY_MS = 100;

export class Worker {
  private readonly deps: WorkerDeps;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;
  private lastSweep = 0;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  /** Recovers expired leases, claims a batch and processes it. Returns the number processed. */
  async runOnce(): Promise<number> {
    const { db, config } = this.deps;
    await this.sweepLeases();
    const claimed = await claimDue(db, config.env.workerBatchSize, config.env.leaseSeconds);
    await Promise.all(claimed.map((claim) => this.track(this.process(claim))));
    return claimed.length;
  }

  start(): void {
    if (this.loop !== undefined) return;
    this.loop = this.run();
  }

  /**
   * Stops claiming new work and waits up to `graceMs` for in-flight requests. Requests still
   * running after that are aborted; their deliveries are retried or recovered via the lease.
   */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    this.wake?.();
    const finished = Promise.all([this.loop, ...this.inFlight]).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, graceMs);
    });
    const result = await Promise.race([finished.then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.deps.logger.warn('shutdown grace period elapsed; aborting in-flight deliveries');
      this.abort.abort();
      await finished;
    }
  }

  private async run(): Promise<void> {
    const { config, logger } = this.deps;
    while (!this.stopping) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (err) {
        logger.error({ err }, 'worker iteration failed');
      }
      // A full batch means more work is probably waiting; otherwise idle until the next poll.
      if (processed < config.env.workerBatchSize) {
        await this.sleep(config.env.workerPollIntervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      if (this.stopping) finish();
    });
  }

  private track(promise: Promise<void>): Promise<void> {
    this.inFlight.add(promise);
    return promise.finally(() => this.inFlight.delete(promise));
  }

  private async sweepLeases(): Promise<void> {
    const now = Date.now();
    const interval = this.deps.leaseSweepIntervalMs ?? DEFAULT_LEASE_SWEEP_INTERVAL_MS;
    if (now - this.lastSweep < interval) return;
    this.lastSweep = now;
    const recovered = await recoverExpiredLeases(this.deps.db, this.deps.config.relay.targets);
    if (recovered > 0) {
      this.deps.metrics.inc('leases_recovered_total', {}, recovered);
      this.deps.logger.warn({ recovered }, 'recovered deliveries with expired leases');
    }
  }

  /**
   * Handles one claimed delivery. A failure here (for example the database becoming unavailable
   * while loading the body or recording the result) must not affect sibling deliveries or the
   * loop: the delivery simply stays `in_flight` and is recovered when its lease expires.
   */
  private async process(claim: ClaimedDelivery): Promise<void> {
    try {
      await this.attempt(claim);
    } catch (err) {
      this.deps.logger.error(
        { err, deliveryId: claim.id, targetId: claim.targetId, attempt: claim.attempts },
        'delivery processing failed; the lease will expire and the delivery will be recovered',
      );
    }
  }

  private async attempt(claim: ClaimedDelivery): Promise<void> {
    const { db, config, forwarder, logger, metrics } = this.deps;
    const startedAt = new Date();
    const started = process.hrtime.bigint();
    const elapsedMs = (): number => Math.round(Number(process.hrtime.bigint() - started) / 1e6);

    const target = config.relay.targets.get(claim.targetId);
    let outcome: ForwardOutcome;
    let completion: Completion | undefined;

    if (target === undefined) {
      outcome = { kind: 'permanent', statusCode: 0, error: 'target is no longer configured' };
      completion = { kind: 'dead', reason: 'unknown_target' };
    } else {
      const event = await db.event.findUnique({
        where: { id: claim.eventId },
        select: { body: true, contentType: true },
      });
      // A missing event can only mean it was deleted after the claim; treat it like a purge.
      if (event === null || event.body === null) {
        outcome = { kind: 'permanent', statusCode: 0, error: 'event body is no longer stored' };
        completion = { kind: 'dead', reason: 'body_purged' };
      } else {
        outcome = await forwarder.forward({
          target,
          eventId: claim.eventId,
          deliveryId: claim.id,
          attempt: claim.attempts,
          body: Buffer.from(event.body),
          contentType: event.contentType,
          signal: this.abort.signal,
        });
      }
    }

    completion ??= this.decide(outcome, claim, target);
    const statusCode = 'statusCode' in outcome && outcome.statusCode ? outcome.statusCode : null;
    const error = outcome.kind === 'delivered' ? null : outcome.error;

    const applied = await this.record(
      claim,
      { startedAt, durationMs: elapsedMs(), statusCode, error },
      completion,
    );

    const result =
      completion.kind === 'delivered'
        ? 'delivered'
        : completion.kind === 'retry'
          ? 'retry'
          : 'dead';
    metrics.inc('delivery_attempts_total', { target: claim.targetId, result });
    logger.info(
      {
        deliveryId: claim.id,
        eventId: claim.eventId,
        targetId: claim.targetId,
        attempt: claim.attempts,
        result,
        statusCode,
        durationMs: elapsedMs(),
        applied,
      },
      applied ? 'delivery attempt finished' : 'delivery attempt result discarded: lease was lost',
    );
  }

  /**
   * Records an outcome, retrying briefly on database errors. The request has already been made,
   * so losing the result would cause a duplicate delivery once the lease expires.
   */
  private async record(
    claim: ClaimedDelivery,
    attempt: AttemptRecord,
    completion: Completion,
  ): Promise<boolean> {
    for (let tries = 1; ; tries++) {
      try {
        return await completeAttempt(this.deps.db, claim, attempt, completion);
      } catch (err) {
        if (tries >= RECORD_TRIES) throw err;
        this.deps.logger.warn(
          { err, deliveryId: claim.id, tries },
          'recording delivery outcome failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * tries));
      }
    }
  }

  private decide(
    outcome: ForwardOutcome,
    claim: ClaimedDelivery,
    target: TargetConfig | undefined,
  ): Completion {
    if (outcome.kind === 'delivered') return { kind: 'delivered' };
    if (outcome.kind === 'permanent') return { kind: 'dead', reason: 'permanent_status' };
    // `target` is defined here: the unknown-target case returned a completion earlier.
    const cfg = target as TargetConfig;
    const used = claim.attempts - claim.attemptsBase;
    if (used >= cfg.maxAttempts) return { kind: 'dead', reason: 'max_attempts' };
    return {
      kind: 'retry',
      delayMs: computeBackoffMs(used, cfg.backoff, this.deps.random),
    };
  }
}
