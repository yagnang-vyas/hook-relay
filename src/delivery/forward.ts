import { createHmac } from 'node:crypto';
import { Agent, fetch } from 'undici';
import type { NetworkConfig, TargetConfig } from '../config.js';
import { SsrfError, assertSafeTarget, createGuardedLookup, type Resolver } from './ssrf.js';

export interface ForwardRequest {
  target: TargetConfig;
  eventId: string;
  deliveryId: string;
  /** 1-based lifetime attempt number. */
  attempt: number;
  body: Buffer;
  contentType: string | null;
  /** Aborts the request early (for example when the process is shutting down). */
  signal?: AbortSignal;
}

export type ForwardOutcome =
  | { kind: 'delivered'; statusCode: number }
  | { kind: 'permanent'; statusCode: number; error: string }
  | { kind: 'retryable'; statusCode?: number; error: string };

export interface Forwarder {
  forward(request: ForwardRequest): Promise<ForwardOutcome>;
  close(): Promise<void>;
}

export interface ForwarderOptions {
  network: NetworkConfig;
  relaySigningSecret: string;
  /** Overrides DNS resolution in the pre-flight check (tests). */
  resolver?: Resolver;
}

const MAX_ERROR_LENGTH = 300;
const USER_AGENT = 'HookRelay/0.1.0';

/** The signature targets can verify to confirm that a request came from this relay. */
export function relaySignature(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function classifyStatus(statusCode: number): ForwardOutcome {
  if (statusCode >= 200 && statusCode < 300) return { kind: 'delivered', statusCode };
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return { kind: 'permanent', statusCode, error: `target responded with HTTP ${statusCode}` };
  }
  return { kind: 'retryable', statusCode, error: `target responded with HTTP ${statusCode}` };
}

/** A short, payload-free description of a transport failure. */
export function describeError(err: unknown): string {
  if (err instanceof SsrfError) return `blocked: ${err.message}`;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'request timed out';
    if (err.name === 'AbortError') return 'request aborted';
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof SsrfError) return `blocked: ${cause.message}`;
    const code =
      cause instanceof Error
        ? (cause as { code?: unknown }).code
        : (err as { code?: unknown }).code;
    if (typeof code === 'string') return `network error: ${code}`.slice(0, MAX_ERROR_LENGTH);
    return `${err.name}: ${err.message}`.slice(0, MAX_ERROR_LENGTH);
  }
  return 'unknown error';
}

/** Discards an unread response body. A failure here must not change the delivery outcome. */
export async function releaseBody(response: {
  body: { cancel(): Promise<void> } | null;
}): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is being discarded anyway.
  }
}

export function createForwarder(options: ForwarderOptions): Forwarder {
  const policy = options.network;
  // Connections are validated at dial time as well as before the request (DNS rebinding).
  const agent = new Agent({
    connect: { lookup: createGuardedLookup(policy) },
    keepAliveTimeout: 4_000,
  });

  return {
    async forward(request) {
      const { target } = request;
      try {
        const url = new URL(target.url);
        await assertSafeTarget(url, policy, options.resolver);

        const signals = [AbortSignal.timeout(target.timeoutMs)];
        if (request.signal !== undefined) signals.push(request.signal);

        const response = await fetch(url, {
          method: 'POST',
          dispatcher: agent,
          redirect: 'manual',
          signal: AbortSignal.any(signals),
          headers: {
            'content-type': request.contentType ?? 'application/octet-stream',
            'user-agent': USER_AGENT,
            'x-hookrelay-event-id': request.eventId,
            'x-hookrelay-delivery-id': request.deliveryId,
            'x-hookrelay-attempt': String(request.attempt),
            'x-hookrelay-signature': relaySignature(options.relaySigningSecret, request.body),
          },
          body: request.body,
        });
        const outcome = classifyStatus(response.status);
        // The response body is never stored; release the connection without reading it.
        await releaseBody(response);
        return outcome;
      } catch (err) {
        return { kind: 'retryable', error: describeError(err) };
      }
    },
    close: () => agent.close(),
  };
}
