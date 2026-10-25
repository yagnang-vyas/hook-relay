import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';
import { serializeError } from './logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Assigns a request ID (honouring a well-formed inbound one) and logs one line per request. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route as { path?: string } | undefined;
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          route: route?.path !== undefined ? `${req.baseUrl}${route.path}` : 'unmatched',
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'request completed',
      );
    });
    next();
  };
}

export function sendError(
  res: Response,
  requestId: string,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message, requestId } });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, req.id, 404, 'not_found', 'Route not found');
};

interface HttpishError {
  status?: number;
  type?: string;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      sendError(res, req.id, err.status, err.code, err.message);
      return;
    }
    const e = (typeof err === 'object' && err !== null ? err : {}) as HttpishError;
    switch (e.type) {
      case 'entity.too.large':
        sendError(res, req.id, 413, 'payload_too_large', 'Request body is too large');
        return;
      case 'encoding.unsupported':
        sendError(res, req.id, 415, 'unsupported_encoding', 'Content-Encoding is not supported');
        return;
      case 'entity.parse.failed':
        sendError(res, req.id, 400, 'invalid_json', 'Request body is not valid JSON');
        return;
      case 'request.aborted':
      case 'request.size.invalid':
      case 'charset.unsupported':
        sendError(res, req.id, 400, 'invalid_request', 'Request body could not be read');
        return;
      default:
        break;
    }
    logger.error({ requestId: req.id, err }, 'unhandled error');
    sendError(res, req.id, 500, 'internal_error', 'Internal server error');
  };
}

export { serializeError };
