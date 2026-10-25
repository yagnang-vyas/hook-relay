import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { RelayConfig } from '../config.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { Metrics } from '../metrics.js';
import type { Db } from '../prisma.js';
import { listDeadDeliveries, retryDeadDelivery } from '../store/deliveries.js';
import {
  DELIVERY_STATUSES,
  getEvent,
  getEventBody,
  listEvents,
  replayEvent,
} from '../store/events.js';

export interface AdminDeps {
  relay: RelayConfig;
  db: Db;
  metrics: Metrics;
  adminApiKey: string;
}

const UUID = z.uuid();
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const limitParam = z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

const listEventsQuery = z.strictObject({
  source: z.string().min(1).max(64).optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  limit: limitParam,
  cursor: z.string().min(1).max(128).optional(),
});

const listDeadQuery = z.strictObject({
  limit: limitParam,
  cursor: z.string().min(1).max(128).optional(),
});

const eventQuery = z.strictObject({
  includeBody: z.enum(['true', 'false']).default('false'),
});

const replayBody = z
  .strictObject({
    targets: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  })
  .default({});

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
      .join('; ');
    throw badRequest(message, 'validation_error');
  }
  return result.data;
}

/** Cursors are opaque to clients; internally they wrap the last ID of the previous page. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.safeParse(id).success || encodeCursor(id) !== cursor) {
    throw badRequest('cursor is not valid', 'invalid_cursor');
  }
  return id;
}

function requireId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !UUID.safeParse(value).success) throw notFound();
  return value;
}

/** Constant-time comparison that does not leak the key's length. */
function keysMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/i.exec(header);
  return match?.[1];
}

export function adminAuth(adminApiKey: string): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (token === undefined || !keysMatch(token, adminApiKey)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(new AppError(401, 'unauthorized', 'A valid admin API key is required'));
      return;
    }
    next();
  };
}

export function adminRouter(deps: AdminDeps): Router {
  const router = Router();

  router.use('/api', adminAuth(deps.adminApiKey), express.json({ limit: '100kb' }));

  router.get('/api/events', async (req, res) => {
    const query = parse(listEventsQuery, req.query);
    const { items, nextAfter } = await listEvents(deps.db, {
      source: query.source,
      status: query.status,
      limit: query.limit,
      after: decodeCursor(query.cursor),
    });
    res.json({ data: items, nextCursor: nextAfter === null ? null : encodeCursor(nextAfter) });
  });

  router.get('/api/events/:id', async (req, res) => {
    const id = requireId(req.params['id']);
    const { includeBody } = parse(eventQuery, req.query);
    const event = await getEvent(deps.db, id);
    if (event === null) throw notFound('Event not found');
    const { deliveries, ...metadata } = event;
    const body = includeBody === 'true' ? await getEventBody(deps.db, id) : undefined;
    res.json({
      ...metadata,
      ...(body !== undefined ? { bodyBase64: body === null ? null : body.toString('base64') } : {}),
      deliveries: deliveries.map(({ attemptLog, ...delivery }) => ({
        ...delivery,
        attemptHistory: attemptLog.map(({ deliveryId: _deliveryId, ...attempt }) => attempt),
      })),
    });
  });

  router.post('/api/events/:id/replay', async (req, res) => {
    const id = requireId(req.params['id']);
    const { targets } = parse(replayBody, req.body as unknown);
    const result = await replayEvent(
      deps.db,
      id,
      ({ sourceId, deliveryTargets }) => {
        const source = deps.relay.sources.get(sourceId);
        const candidates = source !== undefined ? source.targets : deliveryTargets;
        return candidates.filter((t) => deps.relay.targets.has(t));
      },
      targets,
    );
    switch (result.status) {
      case 'not_found':
        throw notFound('Event not found');
      case 'body_purged':
        throw conflict('The event body has been purged by the retention policy', 'body_purged');
      case 'invalid_target':
        throw badRequest(
          `target "${result.target}" is not a configured target of this event's source`,
          'invalid_target',
        );
      case 'created':
        deps.metrics.inc('replays_total', {}, result.deliveries.length);
        res.status(201).json({ deliveries: result.deliveries });
    }
  });

  router.get('/api/deliveries/dead', async (req, res) => {
    const query = parse(listDeadQuery, req.query);
    const { items, nextAfter } = await listDeadDeliveries(
      deps.db,
      query.limit,
      decodeCursor(query.cursor),
    );
    res.json({ data: items, nextCursor: nextAfter === null ? null : encodeCursor(nextAfter) });
  });

  router.post('/api/deliveries/:id/retry', async (req, res) => {
    const id = requireId(req.params['id']);
    const result = await retryDeadDelivery(deps.db, id);
    switch (result.status) {
      case 'not_found':
        throw notFound('Delivery not found');
      case 'not_dead':
        throw conflict(`Delivery is ${result.current}, not dead`, 'not_dead');
      case 'body_purged':
        throw conflict('The event body has been purged by the retention policy', 'body_purged');
      case 'requeued': {
        deps.metrics.inc('manual_retries_total');
        const delivery = await deps.db.delivery.findUniqueOrThrow({ where: { id } });
        res.json(delivery);
      }
    }
  });

  router.get('/api/metrics', (_req, res) => {
    res.json({ counters: deps.metrics.snapshot() });
  });

  return router;
}
