// Simulated POST /hooks/{sourceId}. Same decision order as src/routes/ingest.ts: source lookup,
// body limit, signature over the raw body, delivery ID, then dedup-and-persist. Never touches the
// network; the "server" is the local registry.

import { ingestEvent, type Registry } from './registry';
import { DEMO_SOURCES } from './samples';
import { verifySignature, type FailureReason } from './signature';

export const SIM_MAX_BODY_BYTES = 1_048_576;

export interface SimRequest {
  sourceId: string;
  /** Request headers as sent (signature header included when present). */
  headers: Record<string, string>;
  body: string;
}

export interface SimResponse {
  status: number;
  body: unknown;
  /** What the real service logs and counts but never returns to the caller. */
  serverNote?: string | undefined;
  registry: Registry;
  requestId: string;
}

const lookup = (headers: Record<string, string>, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
};

export async function simulateIngest(
  req: SimRequest,
  registry: Registry,
  nowMs: number,
): Promise<SimResponse> {
  const requestId = `sim-req-${String(registry.seq + 1).padStart(4, '0')}`;
  const fail = (
    status: number,
    code: string,
    message: string,
    serverNote?: string,
  ): SimResponse => ({
    status,
    body: { error: { code, message, requestId } },
    serverNote,
    registry,
    requestId,
  });

  const source = DEMO_SOURCES.find((s) => s.id === req.sourceId);
  if (source === undefined) return fail(404, 'unknown_source', 'Unknown webhook source');
  if (new TextEncoder().encode(req.body).length > SIM_MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', 'Request body exceeds the configured limit');
  }

  const verdict = await verifySignature(
    source.scheme,
    lookup(req.headers, source.signatureHeader),
    source.secret,
    req.body,
    { toleranceSeconds: source.toleranceSeconds, nowSeconds: Math.floor(nowMs / 1000) },
  );
  if (!verdict.valid) {
    const reason: FailureReason = verdict.reason;
    return fail(
      401,
      'invalid_signature',
      'Unauthorized',
      `invalid_signatures_total{reason="${reason}"} +1; reason logged, not returned`,
    );
  }

  const outcome = ingestEvent(
    registry,
    {
      sourceId: source.id,
      deliveryId: lookup(req.headers, source.deliveryIdHeader),
      payload: req.body,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          ([k]) => k.toLowerCase() !== source.signatureHeader.toLowerCase(),
        ),
      ),
      targets: source.targets,
    },
    nowMs,
  );
  if (!outcome.ok) return fail(400, 'invalid_delivery_id', outcome.error);
  if (outcome.outcome.status === 'duplicate') {
    return {
      status: 200,
      body: { status: 'duplicate' },
      serverNote: `events_duplicate_total +1; matched existing ${outcome.outcome.existingEventId}; nothing stored`,
      registry,
      requestId,
    };
  }
  return {
    status: 202,
    body: { status: 'accepted', eventId: outcome.outcome.eventId },
    registry: outcome.registry,
    requestId,
  };
}
