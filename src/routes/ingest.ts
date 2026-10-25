import express, { Router, type RequestHandler } from 'express';
import type { RelayConfig, SourceConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type { Db } from '../prisma.js';
import { verifySignature } from '../signatures/index.js';
import { persistEvent } from '../store/events.js';
import { randomUUID } from 'node:crypto';

/** Headers worth keeping for inspection. Signature and credential headers are never stored. */
const STORED_HEADERS = [
  'content-type',
  'user-agent',
  'x-request-id',
  'x-github-event',
  'x-github-delivery',
  'x-event-id',
  'x-event-type',
];
const MAX_STORED_HEADER_LENGTH = 512;
const DELIVERY_ID = /^[\x21-\x7e]{1,255}$/;

export interface IngestDeps {
  relay: RelayConfig;
  db: Db;
  logger: Logger;
  metrics: Metrics;
  now: () => number;
}

function pickHeaders(req: express.Request, source: SourceConfig): Record<string, string> {
  const names = new Set(STORED_HEADERS);
  if (source.deliveryIdHeader !== undefined) names.add(source.deliveryIdHeader.toLowerCase());
  // Never store anything that could carry a signature, even if listed above by configuration.
  names.delete(source.scheme.header.toLowerCase());
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = req.get(name);
    if (value !== undefined) picked[name] = value.slice(0, MAX_STORED_HEADER_LENGTH);
  }
  return picked;
}

export function ingestRouter(deps: IngestDeps): Router {
  const router = Router();

  const lookupSource: RequestHandler = (req, res, next) => {
    const source = deps.relay.sources.get(String(req.params['sourceId']));
    if (source === undefined) {
      next(new AppError(404, 'unknown_source', 'Unknown webhook source'));
      return;
    }
    res.locals['source'] = source;
    next();
  };

  // The body is read as raw bytes: signatures are computed over exactly what was sent, and
  // JSON is never parsed before verification. Content-Encoding is rejected (inflate: false)
  // because providers sign the bytes they send, which may differ from a decompressed form.
  const rawBody = express.raw({ type: () => true, limit: deps.relay.maxBodyBytes, inflate: false });

  router.post('/hooks/:sourceId', lookupSource, rawBody, async (req, res) => {
    const source = res.locals['source'] as SourceConfig;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const result = verifySignature({
      scheme: source.scheme,
      secrets: source.secrets,
      headerValue: req.get(source.scheme.header),
      body,
      nowMs: deps.now(),
    });
    if (!result.valid) {
      deps.metrics.inc('invalid_signatures_total', { source: source.id, reason: result.reason });
      // Source, reason and request ID only: never the signature header or the body.
      deps.logger.warn(
        { requestId: req.id, sourceId: source.id, reason: result.reason },
        'rejected webhook with invalid signature',
      );
      throw new AppError(401, 'invalid_signature', 'Unauthorized');
    }

    let deliveryId: string;
    let generatedId = false;
    const provided =
      source.deliveryIdHeader !== undefined ? req.get(source.deliveryIdHeader)?.trim() : undefined;
    if (provided === undefined || provided === '') {
      deliveryId = `gen_${randomUUID()}`;
      generatedId = true;
    } else if (DELIVERY_ID.test(provided)) {
      deliveryId = provided;
    } else {
      throw new AppError(400, 'invalid_delivery_id', 'Delivery ID header is not acceptable');
    }

    const outcome = await persistEvent(deps.db, {
      sourceId: source.id,
      deliveryId,
      generatedId,
      headers: pickHeaders(req, source),
      contentType: req.get('content-type') ?? null,
      body,
      targetIds: source.targets,
    });

    if (outcome.status === 'duplicate') {
      deps.metrics.inc('events_duplicate_total', { source: source.id });
      res.status(200).json({ status: 'duplicate' });
      return;
    }
    deps.metrics.inc('events_accepted_total', { source: source.id });
    // Reached only after the transaction committed.
    res.status(202).json({ status: 'accepted', eventId: outcome.eventId });
  });

  return router;
}
