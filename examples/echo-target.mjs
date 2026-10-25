// A tiny downstream service for trying HookRelay. It shows what a well-behaved target does:
//   1. verifies X-HookRelay-Signature (an HMAC of the body keyed with RELAY_SIGNING_SECRET),
//   2. deduplicates on X-HookRelay-Event-Id, because delivery is at-least-once,
//   3. answers 2xx only once it has handled the event.
// Set ECHO_FAIL_FIRST=n to answer the first n requests with 503 and watch HookRelay retry.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createEchoServer({ secret, failFirst = 0, log = console.log } = {}) {
  const seenEvents = new Set();
  let requests = 0;

  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const provided = String(req.headers['x-hookrelay-signature'] ?? '');
      const valid =
        provided.length === expected.length &&
        timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      if (!valid) {
        log('rejected: bad X-HookRelay-Signature');
        res.writeHead(401).end();
        return;
      }

      requests += 1;
      if (requests <= failFirst) {
        log(
          `simulated outage: answering 503 (request ${requests} of ${failFirst} planned failures)`,
        );
        res.writeHead(503).end();
        return;
      }

      const eventId = String(req.headers['x-hookrelay-event-id']);
      const attempt = String(req.headers['x-hookrelay-attempt']);
      if (seenEvents.has(eventId)) {
        log(
          `event ${eventId} (attempt ${attempt}): already handled, acknowledging without reprocessing`,
        );
      } else {
        seenEvents.add(eventId);
        log(
          `event ${eventId} (attempt ${attempt}): ${body.length} bytes: ${body.toString('utf8')}`,
        );
      }
      res.writeHead(200).end('ok');
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const secret = process.env.RELAY_SIGNING_SECRET;
  if (!secret) {
    console.error('RELAY_SIGNING_SECRET is required');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8080);
  const server = createEchoServer({ secret, failFirst: Number(process.env.ECHO_FAIL_FIRST ?? 0) });
  server.listen(port, '0.0.0.0', () => console.log(`echo target listening on ${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
