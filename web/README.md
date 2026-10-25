# HookRelay console

A standalone React + TypeScript + Vite + Tailwind app with two parts:

- **Dashboard** reads a running HookRelay through its existing admin API and shows the overview,
  events, delivery attempts, the dead letter queue and system health. It can replay an event and
  retry a dead delivery after an explicit confirmation.
- **Playground** is a local simulation. It needs no server and no API key, makes no network
  requests, and every result is labelled as simulated.

HookRelay does not depend on this app. It adds no routes, no database objects and no environment
variables to the service, which behaves exactly as before when the console is not deployed.

## Dashboard

| Page              | Uses                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| Overview          | `GET /api/metrics`, `GET /api/events`, `GET /api/deliveries/dead`, health |
| Events            | `GET /api/events` with `source`, `status`, `limit` and cursor paging      |
| Event details     | `GET /api/events/:id`, payload on demand with `includeBody=true`          |
| Dead Letter Queue | `GET /api/deliveries/dead`, `POST /api/deliveries/:id/retry`              |
| System Health     | `GET /healthz` (liveness) and `GET /readyz` (readiness), shown separately |
| Connection        | API base URL and admin key                                                |

Things worth knowing:

- Counters on the Overview come from `GET /api/metrics`. They are per-process, reset on restart and
  are not durable history or cluster-wide totals. The event-status breakdown is computed only from
  the most recent page of events because the API has no global totals.
- Payloads are fetched only when you click **Load payload** and are displayed as plain text or
  pretty-printed JSON, never as HTML. Purged payloads and `409` conflicts are reported as such.
- **Replay event** and **Retry delivery** open a confirmation that explains at-least-once delivery.
  The confirm button is disabled while the request is in flight. The result dialog shows what the
  server returned (new deliveries are `pending`); it never claims a delivery succeeded.
- Errors keep the server's `code`, `message` and request ID. `401`, `403`, `404`, `409`, `429` and
  `5xx` get specific wording; requests time out after 15 s and are cancelled when you navigate away.

## Playground

Pick a tab. All state is in memory and **Reset** or **Clear** buttons restore the defaults.

| Tab                | What it does                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request            | Edit a JSON payload and headers, choose a demo source and signature mode, preview the request, run it against a local model of `POST /hooks/:sourceId` (202, 200 duplicate, 401, 404, 413, 400). Invalid JSON blocks the run and is never auto-corrected. |
| Signature lab      | HMAC-SHA256 with Web Crypto: `sha256=hex`, `hex`, `base64` and timestamped `t=,v1=`. Valid, tampered, wrong secret, malformed, missing, re-serialised and stale examples, plus your own header.                                                           |
| Delivery & retries | Seven scenarios (immediate success, 503 then success, timeout then recovery, repeated 5xx, exhausted budget, permanent 4xx, manual retry) with a timeline you can run, step, pause and reset.                                                             |
| Duplicates         | Local registry showing first delivery, repeat (200 duplicate), new ID, generated IDs and the same ID under another source.                                                                                                                                |
| Event inspector    | Inspect simulated events, run their deliveries, replay them, retry dead deliveries.                                                                                                                                                                       |
| Dead letter        | Run to a dead-letter record, then trigger a simulated manual retry that recovers or fails again.                                                                                                                                                          |

How faithful is it? The classification (2xx delivers, 4xx other than 408 and 429 is permanent, the
rest retries), the retry-budget accounting, the backoff formula (`min(max, base × 2^(n-1))` with full
jitter) and the verification rules mirror `src/delivery` and `src/signatures`. They are copied into
`src/playground`, not imported, so the playground cannot affect the service. Timings are virtual and
jitter is seeded, so they are illustrative. Browser verification demonstrates the arithmetic only;
the real server verifies the raw request bytes in constant time and answers every failure with the
same generic `401`. Secrets in the playground are public, fake and demo-only. Never paste real
secrets into it.

## Develop

Requires Node 22.19 or newer.

```bash
cd web
npm ci
npm run dev        # http://127.0.0.1:5173, proxies /api, /healthz and /readyz to http://127.0.0.1:3000
npm run check      # typecheck, tests and production build
```

Set `HOOKRELAY_DEV_TARGET=http://host:port` to proxy the dev server to a different HookRelay. Run
HookRelay as usual (for example `docker compose up`) and enter its `ADMIN_API_KEY` on the Connection page.

## Deploy

HookRelay sends no CORS headers, so the browser must see the console and the API on one origin.

- **Docker Compose** (recommended): `docker compose --profile ui up --build web` builds the static
  app into an unprivileged nginx that serves it and reverse-proxies only `/api/*`, `/healthz` and
  `/readyz` to the `app` service. `/hooks/*` is not proxied. It listens on `127.0.0.1:5173`; put TLS
  in front of it before exposing it. `web/nginx.conf` also sets a restrictive Content-Security-Policy.
- **Your own reverse proxy**: serve `web/dist` (`npm run build`) and route `/api`, `/healthz` and
  `/readyz` to HookRelay on the same host.
- **Different origins**: set the API base URL on the Connection page (or `VITE_HOOKRELAY_API_BASE_URL`
  at build time) and add CORS handling in your proxy, including `Authorization` in allowed headers.

| Setting                       | Where            | Notes                                              |
| ----------------------------- | ---------------- | -------------------------------------------------- |
| `VITE_HOOKRELAY_API_BASE_URL` | build time       | Optional, non-secret. Empty means same origin.     |
| `HOOKRELAY_DEV_TARGET`        | `npm run dev`    | Dev proxy target, default `http://127.0.0.1:3000`. |
| Admin API key                 | typed in browser | Never build-time, never stored, see below.         |

## Security

- The admin key is entered on the Connection page, held in JavaScript memory, sent only as an
  `Authorization: Bearer` header to the configured base URL, and lost on reload. It is never put in
  `localStorage`, cookies, URLs, build variables or logs. Requests use `credentials: 'omit'`. The
  only value read from the build environment is the optional base URL, and a test enforces that.
- The playground does not import the API client and a test asserts it never calls `fetch`.
- Use a key you are comfortable pasting into a browser, serve the console over HTTPS outside localhost,
  and remember HookRelay has a single admin key with no roles or audit log.

## Known limitations

- No live updates; use **Refresh**.
- No global event totals or historical charts: the API offers none, so none are drawn.
- Replay targets can only be narrowed to targets already seen on the event's deliveries.
- Playground backoff and verification logic are copies; if the service's rules change, update
  `src/playground` and its tests.
- The playground has no "local instance mode": it never talks to a server.
