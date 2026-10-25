import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../prisma.js';

export interface NewEvent {
  sourceId: string;
  deliveryId: string;
  generatedId: boolean;
  headers: Record<string, string>;
  contentType: string | null;
  body: Buffer;
  targetIds: readonly string[];
}

export type PersistResult = { status: 'accepted'; eventId: string } | { status: 'duplicate' };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Stores an event and one pending delivery per target in a single transaction. A repeated
 * (sourceId, deliveryId) pair is reported as a duplicate and leaves nothing behind.
 */
export async function persistEvent(db: Db, input: NewEvent): Promise<PersistResult> {
  try {
    const eventId = await db.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          sourceId: input.sourceId,
          deliveryId: input.deliveryId,
          generatedId: input.generatedId,
          headers: input.headers,
          contentType: input.contentType,
          body: new Uint8Array(input.body),
          bodySize: input.body.length,
        },
        select: { id: true },
      });
      await tx.delivery.createMany({
        data: input.targetIds.map((targetId) => ({ eventId: event.id, targetId })),
      });
      return event.id;
    });
    return { status: 'accepted', eventId };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'duplicate' };
    throw err;
  }
}

export const DELIVERY_STATUSES = ['pending', 'in_flight', 'retrying', 'delivered', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface ListEventsQuery {
  source?: string | undefined;
  status?: DeliveryStatus | undefined;
  limit: number;
  /** Return events strictly older than this event ID. */
  after?: string | undefined;
}

const eventMetadata = {
  id: true,
  sourceId: true,
  deliveryId: true,
  generatedId: true,
  contentType: true,
  headers: true,
  bodySize: true,
  bodyPurged: true,
  receivedAt: true,
} as const;

/** Newest first, keyset-paginated on the (time-ordered) primary key. Metadata only. */
export async function listEvents(db: Db, query: ListEventsQuery) {
  const rows = await db.event.findMany({
    where: {
      ...(query.source !== undefined ? { sourceId: query.source } : {}),
      ...(query.status !== undefined ? { deliveries: { some: { status: query.status } } } : {}),
      ...(query.after !== undefined ? { id: { lt: query.after } } : {}),
    },
    orderBy: { id: 'desc' },
    take: query.limit + 1,
    select: {
      ...eventMetadata,
      deliveries: {
        select: { id: true, targetId: true, status: true, attempts: true },
        orderBy: { id: 'asc' },
      },
    },
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page,
    nextAfter: rows.length > query.limit && last !== undefined ? last.id : null,
  };
}

export async function getEvent(db: Db, id: string) {
  return db.event.findUnique({
    where: { id },
    select: {
      ...eventMetadata,
      deliveries: {
        orderBy: { id: 'asc' },
        include: { attemptLog: { orderBy: { attemptNumber: 'asc' } } },
      },
    },
  });
}

/** The stored payload, or null once it has been purged (or if the event does not exist). */
export async function getEventBody(db: Db, id: string): Promise<Buffer | null> {
  const row = await db.event.findUnique({ where: { id }, select: { body: true } });
  const body = row?.body;
  return body === undefined || body === null ? null : Buffer.from(body);
}

export type ReplayResult =
  | { status: 'not_found' }
  | { status: 'body_purged' }
  | { status: 'invalid_target'; target: string }
  | { status: 'created'; deliveries: { id: string; targetId: string; status: DeliveryStatus }[] };

/**
 * Creates new pending deliveries for an event. The event row is locked `FOR SHARE` so the
 * retention job cannot purge its body between the check and the insert.
 */
export async function replayEvent(
  db: Db,
  eventId: string,
  resolveTargets: (event: { sourceId: string; deliveryTargets: string[] }) => string[],
  requested: readonly string[] | undefined,
): Promise<ReplayResult> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ source_id: string; has_body: boolean }[]>`
      SELECT source_id, body IS NOT NULL AS has_body FROM events WHERE id = ${eventId}::uuid FOR SHARE
    `;
    const event = locked[0];
    if (event === undefined) return { status: 'not_found' } as const;
    if (!event.has_body) return { status: 'body_purged' } as const;

    const existing = await tx.delivery.findMany({
      where: { eventId },
      select: { targetId: true },
      distinct: ['targetId'],
    });
    const allowed = resolveTargets({
      sourceId: event.source_id,
      deliveryTargets: existing.map((d) => d.targetId),
    });
    const targets = requested ?? allowed;
    const bad = targets.find((t) => !allowed.includes(t));
    if (bad !== undefined) return { status: 'invalid_target', target: bad } as const;

    const created = await tx.delivery.createManyAndReturn({
      data: targets.map((targetId) => ({ eventId, targetId })),
      select: { id: true, targetId: true, status: true },
    });
    return { status: 'created', deliveries: created } as const;
  });
}
