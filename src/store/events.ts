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
