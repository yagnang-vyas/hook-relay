// Local, in-memory stand-in for HookRelay's events table, used to demonstrate deduplication.
// It replaces nothing: the real service deduplicates with a unique (source, delivery ID)
// constraint in PostgreSQL inside the persistence transaction.

import { newDelivery, type SimDelivery, type TimelineStep } from './engine';

export interface SimEvent {
  id: string;
  sourceId: string;
  deliveryId: string;
  generatedId: boolean;
  payload: string;
  headers: Record<string, string>;
  receivedAtMs: number;
  deliveries: SimDelivery[];
  timeline: TimelineStep[];
}

export interface Registry {
  events: SimEvent[];
  seq: number;
}

export const emptyRegistry = (): Registry => ({ events: [], seq: 0 });

export type IngestOutcome =
  | { status: 'accepted'; eventId: string; generatedId: boolean; deliveryId: string }
  | { status: 'duplicate'; existingEventId: string };

const DELIVERY_ID = /^[\x21-\x7e]{1,255}$/;

export type SimIngestResult =
  { ok: true; registry: Registry; outcome: IngestOutcome } | { ok: false; error: string };

/** Mirrors the ingest rules after signature verification. */
export function ingestEvent(
  registry: Registry,
  input: {
    sourceId: string;
    deliveryId: string | undefined;
    payload: string;
    headers: Record<string, string>;
    targets: readonly string[];
  },
  nowMs: number,
): SimIngestResult {
  const seq = registry.seq + 1;
  const trimmed = input.deliveryId?.trim();
  let deliveryId: string;
  let generatedId = false;
  if (trimmed === undefined || trimmed === '') {
    deliveryId = `gen_sim-${String(seq).padStart(4, '0')}`;
    generatedId = true;
  } else if (DELIVERY_ID.test(trimmed)) {
    deliveryId = trimmed;
  } else {
    return { ok: false, error: 'Delivery ID header is not acceptable' };
  }
  const existing = registry.events.find(
    (e) => e.sourceId === input.sourceId && e.deliveryId === deliveryId,
  );
  if (existing !== undefined) {
    return { ok: true, registry, outcome: { status: 'duplicate', existingEventId: existing.id } };
  }
  const eventId = `sim-evt-${String(seq).padStart(4, '0')}`;
  const event: SimEvent = {
    id: eventId,
    sourceId: input.sourceId,
    deliveryId,
    generatedId,
    payload: input.payload,
    headers: input.headers,
    receivedAtMs: nowMs,
    deliveries: input.targets.map((t, i) =>
      newDelivery(`sim-dlv-${String(seq).padStart(4, '0')}-${i + 1}`, eventId, t, nowMs),
    ),
    timeline: [
      {
        atMs: nowMs,
        kind: 'accepted',
        title: 'Event accepted (simulated 202)',
        detail: 'Signature verified and delivery ID was new.',
        tone: 'success',
      },
      {
        atMs: nowMs,
        kind: 'delivery_created',
        title: `${input.targets.length} pending delivery record(s) created (simulated)`,
        detail: input.targets.join(', '),
        tone: 'neutral',
      },
    ],
  };
  return {
    ok: true,
    registry: { events: [event, ...registry.events], seq },
    outcome: { status: 'accepted', eventId, generatedId, deliveryId },
  };
}

export function updateEvent(registry: Registry, event: SimEvent): Registry {
  return { ...registry, events: registry.events.map((e) => (e.id === event.id ? event : e)) };
}

/** Mirrors POST /api/events/:id/replay: new pending deliveries, existing ones untouched. */
export function replayEvent(
  registry: Registry,
  eventId: string,
  nowMs: number,
): { registry: Registry; event: SimEvent } | undefined {
  const event = registry.events.find((e) => e.id === eventId);
  if (event === undefined) return undefined;
  const seq = registry.seq + 1;
  const targets = [...new Set(event.deliveries.map((d) => d.targetId))];
  const fresh = targets.map((t, i) =>
    newDelivery(`sim-dlv-${String(seq).padStart(4, '0')}-r${i + 1}`, event.id, t, nowMs),
  );
  const updated: SimEvent = {
    ...event,
    deliveries: [...event.deliveries, ...fresh],
    timeline: [
      ...event.timeline,
      {
        atMs: nowMs,
        kind: 'replay',
        title: 'Operator replay (simulated POST /api/events/:id/replay)',
        detail: `${fresh.length} new pending deliver${fresh.length === 1 ? 'y' : 'ies'} created from the stored payload. Existing deliveries are untouched.`,
        tone: 'info',
      },
    ],
  };
  return { registry: { ...updateEvent(registry, updated), seq }, event: updated };
}
