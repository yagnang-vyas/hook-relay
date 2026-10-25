import { Router } from 'express';
import type { Readiness } from '../db.js';
import type { Logger } from '../logger.js';

export function healthRouter(readiness: Readiness, logger: Logger): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    const result = await readiness();
    if (result.ok) {
      res.json({ status: 'ready' });
      return;
    }
    logger.warn({ requestId: req.id, reason: result.reason }, 'readiness check failed');
    res.status(503).json({ status: 'unavailable', reason: result.reason });
  });

  return router;
}
