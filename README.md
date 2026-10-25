# HookRelay

HookRelay is a self-hosted service that sits between webhook providers (GitHub, Stripe or Razorpay
style senders) and your internal services. It **verifies** each webhook's signature, **stores** it
durably in PostgreSQL, **forwards** it to your services with retries, and gives you an API to
**inspect and replay** everything that arrived.

## Why

Webhook integrations fail quietly. Signatures go unchecked, a downstream outage drops events,
providers retry and cause duplicates, and nobody can see or replay what arrived. HookRelay accepts
the webhook once, writes it to PostgreSQL in a single transaction, answers the provider, and then
takes responsibility for delivery. If your service is down, the event waits; if it keeps failing, the
event lands in a dead-letter queue you can inspect and retry.

## Architecture

```mermaid
flowchart LR
    P[Webhook provider] -->|POST /hooks/:sourceId| I[Ingest<br/>verify signature<br/>dedupe]
    I -->|one transaction:<br/>event + deliveries| DB[(PostgreSQL<br/>queue and history)]
    DB -->|FOR UPDATE SKIP LOCKED| W[Delivery workers<br/>retry with backoff<br/>SSRF guard]
    W -->|POST + X-HookRelay-* headers| T1[orders-service]
    W --> T2[billing-service]
    A[Operator] -->|Bearer token| API[Admin API<br/>inspect, replay, retry]
    API --> DB
```

- **Ingest** and the **admin API** run in the HTTP server. **Workers** run inside the same process by
  default (`WORKER_ENABLED=true`) or as separate processes (`node dist/worker.js`); any number of
  workers can share one database.
- PostgreSQL is the queue. There is no Redis or broker to operate.

## Quick start

Requires Docker with Compose v2 and `openssl`.

```bash
git clone https://github.com/yagnang-vyas/hook-relay.git
cd hook-relay

# 1. Secrets: generate fresh values for every variable named in .env.example.
for v in POSTGRES_PASSWORD ADMIN_API_KEY RELAY_SIGNING_SECRET GITHUB_WEBHOOK_SECRET PAYMENTS_WEBHOOK_SECRET; do
  echo "$v=$(openssl rand -hex 24)"
done > .env

# 2. Configuration: the demo config forwards both sources to a small echo service.
cp examples/demo.config.json hookrelay.config.json

# 3. Start PostgreSQL, run migrations, start HookRelay and the demo echo service.
docker compose --profile demo up --build
```

Without `--profile demo`, only HookRelay and PostgreSQL start; point `targets[].url` at your own
services (see [Configuration](#configuration)). The HTTP port is bound to `127.0.0.1:3000`; put a
reverse proxy with TLS in front of it to receive real webhooks.

### Send a test webhook

In another terminal, in the same directory:

```bash
set -a; . ./.env; set +a
BODY='{"hello":"world"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')

curl -i http://localhost:3000/hooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Delivery: demo-1" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY"
```

You should see `202 Accepted` with an `eventId`. The echo service refuses the first request with a
simulated 503 (`ECHO_FAIL_FIRST`), so within a few seconds its log shows the retry succeeding.
Run the same `curl` again and you get `200 {"status":"duplicate"}` because the delivery ID was seen
before. Change the signature and you get `401`.

Inspect what happened:

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" http://localhost:3000/api/events | head -c 1500
```

Stop everything with `docker compose --profile demo down` (add `-v` to delete the database volume).

## Configuration

Configuration is validated at startup. A missing secret variable, an unknown target reference, a
duplicate ID or any unknown key stops the service with a message that lists every problem.

### Environment variables

| Variable                  | Default                 | Meaning                                                                |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`            | required                | PostgreSQL connection string.                                          |
| `DATABASE_SCHEMA`         | connection default      | Schema holding HookRelay's tables (lower-case identifier).             |
| `ADMIN_API_KEY`           | required, 16+ chars     | Bearer token for `/api/*`.                                             |
| `RELAY_SIGNING_SECRET`    | required, 16+ chars     | Key for the `X-HookRelay-Signature` sent to targets.                   |
| `<source secretEnv>`      | required per source     | Webhook secret(s) for each source. Comma-separated list for rotation.  |
| `CONFIG_PATH`             | `hookrelay.config.json` | Path to the config file.                                               |
| `MIGRATIONS_DIR`          | `prisma/migrations`     | Where `/readyz` and the migration runner find migrations.              |
| `PORT` / `HOST`           | `3000` / `0.0.0.0`      | Listen address.                                                        |
| `LOG_LEVEL`               | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.        |
| `WORKER_ENABLED`          | `true`                  | Run a delivery worker inside the server process.                       |
| `WORKER_BATCH_SIZE`       | `10`                    | Deliveries claimed per poll (also the concurrency of one worker).      |
| `WORKER_POLL_INTERVAL_MS` | `1000`                  | Idle wait between polls.                                               |
| `LEASE_SECONDS`           | `60`                    | How long a claimed delivery may stay in flight before it is recovered. |
| `SHUTDOWN_GRACE_MS`       | `15000`                 | How long shutdown waits for in-flight requests.                        |

### `hookrelay.config.json`

See [`hookrelay.config.example.json`](hookrelay.config.example.json) and
[`examples/demo.config.json`](examples/demo.config.json).

| Key                                  | Default            | Meaning                                                                               |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| `sources[].id`                       |                    | Used in the URL: `POST /hooks/<id>`.                                                  |
| `sources[].secretEnv`                |                    | Name of the environment variable holding the secret (comma-separated for rotation).   |
| `sources[].scheme`                   |                    | Signature scheme, below.                                                              |
| `sources[].deliveryIdHeader`         | none               | Header carrying the provider's unique delivery ID, used for duplicate detection.      |
| `sources[].targets[]`                |                    | IDs of the targets that receive this source's events.                                 |
| `targets[].id` / `url`               |                    | Target identity and endpoint. Targets come from this file only, never from a request. |
| `targets[].timeoutMs`                | `10000`            | Per-request timeout (100 to 30000). Must be at least 5s shorter than `LEASE_SECONDS`. |
| `targets[].maxAttempts`              | `8`                | Attempts before a delivery is dead-lettered.                                          |
| `targets[].backoff.baseMs` / `maxMs` | `2000` / `3600000` | Exponential backoff with full jitter, capped at `maxMs`.                              |
| `network.allowPrivateTargets`        | `[]`               | Hostnames exempt from the SSRF guard (for example `orders` in a private network).     |
| `network.allowHttp`                  | `false`            | Permit `http:` targets. Otherwise only `https:`.                                      |
| `maxBodyBytes`                       | `1048576`          | Larger requests get `413`.                                                            |
| `retentionDays`                      | `14`               | Age after which stored bodies are deleted (metadata is kept).                         |

Signature schemes:

- `{"type":"hmac-sha256","header":"X-Hub-Signature-256","format":"sha256=hex"}`: HMAC-SHA256 of the
  raw body. `format` is `sha256=hex` (GitHub style), `hex`, or `base64`.
- `{"type":"timestamped-hmac-sha256","header":"X-Signature","toleranceSeconds":300}`: a header
  `t=<unix>,v1=<hex>[,v1=<hex>]` where each `v1` is the HMAC-SHA256 of `"<t>.<raw body>"`. Requests
  whose timestamp is further than the tolerance from now are rejected, which limits replay.

**Secret rotation.** Set the source's secret variable to `new-secret,old-secret`, restart, switch the
provider to the new secret, then remove the old one. A signature made with any listed secret is valid.

## Delivery semantics

HookRelay provides **at-least-once** delivery. Once it has answered `202`, the event is committed in
PostgreSQL and will be delivered at least once unless it exhausts its retries. The same event can be
delivered more than once, for example when a target processes a request but the response is lost, when
a worker crashes before recording the outcome, or after a manual replay.

**Targets must deduplicate on `X-HookRelay-Event-Id`**, which is the same for every attempt and
replay of an event. `X-HookRelay-Delivery-Id` identifies one (event, target) delivery and
`X-HookRelay-Attempt` is the attempt number. [`examples/echo-target.mjs`](examples/echo-target.mjs)
shows a target that verifies the signature and deduplicates.

Each forwarded request is a `POST` with the original body bytes and content type, plus:

| Header                    | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| `X-HookRelay-Event-Id`    | Stable ID of the stored event.                                             |
| `X-HookRelay-Delivery-Id` | ID of this event-and-target delivery.                                      |
| `X-HookRelay-Attempt`     | Attempt number, counting from 1.                                           |
| `X-HookRelay-Signature`   | `sha256=<hex>`: HMAC-SHA256 of the body keyed with `RELAY_SIGNING_SECRET`. |

Outcomes:

| Target response                                    | Result                                              |
| -------------------------------------------------- | --------------------------------------------------- |
| 2xx                                                | `delivered`                                         |
| 4xx except 408 and 429                             | `dead` immediately (the request itself is rejected) |
| 408, 429, 5xx, redirects, timeouts, network errors | retried with backoff, `dead` after `maxAttempts`    |

Redirects are never followed. Events with duplicate `(source, delivery ID)` are acknowledged without
being stored again. If a provider sends no delivery ID, HookRelay generates one and marks the event
`generatedId: true`; those cannot be deduplicated. Ordering between events is not guaranteed.

## Security model

- **Signatures** are verified over the raw bytes before anything is parsed, with constant-time
  comparison, and malformed headers are rejected without throwing. Rejected requests are generic
  `401`s; the reason is logged and counted per source.
- **Secrets** come from environment variables only. Neither secrets, signatures, `Authorization`
  headers nor payload bodies are logged; log redaction is configured and covered by tests, and
  database errors (which can echo payloads) are logged as type and code only.
- **SSRF.** Targets come only from the config file. Before each request the target host is resolved and
  rejected if any address is loopback, private (RFC 1918), link-local (including `169.254.169.254`),
  carrier-grade NAT, unique-local IPv6, multicast, reserved or unspecified, including IPv4-mapped
  IPv6 forms. The address actually dialled is validated again at connect time, which defeats DNS
  rebinding. Redirects are not followed and `http:` needs `network.allowHttp`. Hostnames in
  `allowPrivateTargets` are exempt, so list only hosts you control.
- **Admin API** requires `Authorization: Bearer <ADMIN_API_KEY>`, compared in constant time. There is
  no per-user auth or TLS in the service itself: expose the admin API only on a trusted network or
  behind a reverse proxy.
- **Stored data.** Bodies are stored as received and deleted after `retentionDays`; headers are an
  allow-list and never include signatures or credentials. Database access control and encryption at
  rest are up to you.
- **Containers** run as a non-root user with a read-only filesystem and no extra capabilities.

## Admin API

All endpoints under `/api` need `Authorization: Bearer <ADMIN_API_KEY>`. Errors always look like
`{"error":{"code","message","requestId"}}`. The full contract is in [`openapi.yaml`](openapi.yaml).

| Endpoint                         | Purpose                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/events`                | List events (`source`, `status`, `limit`, `cursor`). Metadata only, keyset paging.    |
| `GET /api/events/:id`            | Event with deliveries and every attempt. `?includeBody=true` adds the body as base64. |
| `POST /api/events/:id/replay`    | Create new pending deliveries; optional `{"targets":["orders-service"]}`.             |
| `GET /api/deliveries/dead`       | The dead-letter queue.                                                                |
| `POST /api/deliveries/:id/retry` | Give a dead delivery a fresh retry budget and requeue it.                             |
| `GET /api/metrics`               | In-process counters (invalid signatures, duplicates, attempts, ...).                  |
| `GET /healthz`, `GET /readyz`    | Liveness; readiness (database reachable and migrations applied). Unauthenticated.     |

```bash
# Replay an event to one target
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"targets":["orders-service"]}' http://localhost:3000/api/events/<event-id>/replay
```

## Operations

- **Migrations.** `docker compose` runs a one-shot `migrate` service before the app starts. Outside
  compose run `npm run db:migrate` (development) or `node dist/migrate-cli.js` (built image). The
  runner is compatible with `prisma migrate deploy`; see SPEC.md for why it exists.
- **Scaling workers.** Run more processes with `node dist/worker.js` (same environment), or more
  server replicas. Workers claim rows with `FOR UPDATE SKIP LOCKED`, so they never take the same
  delivery. Set `WORKER_ENABLED=false` on server replicas that should only ingest.
- **Crashes.** A delivery whose worker dies stays `in_flight` until its lease (`LEASE_SECONDS`)
  expires; any worker then returns it to the queue. A crashed attempt counts toward `maxAttempts`.
- **Graceful shutdown.** On `SIGTERM` the server stops accepting connections, the worker stops
  claiming, in-flight requests get up to `SHUTDOWN_GRACE_MS`, and anything still running is aborted
  and rescheduled. Compose gives the app a 30 second stop grace period.
- **Retention.** An hourly job deletes the bodies of events older than `retentionDays` in batches. It
  keeps metadata and never touches events with undelivered work. Replay and manual retry of a purged
  event answer `409`.
- **Logs** are JSON lines on stdout with a request ID on every line (`X-Request-Id` is honoured if
  well-formed, otherwise generated, and returned on every response).

## Web console and playground (optional)

`web/` holds a standalone React app with two parts. The **dashboard** reads your running instance
through the existing admin API (overview, events and delivery attempts, dead letter queue, replay and
retry, health). The **playground** is a local simulation of signatures, retries, duplicates and
dead letters that needs no server and no key. HookRelay itself is unchanged and runs exactly as before
without it. See [web/README.md](web/README.md).

```bash
docker compose --profile ui up --build web   # then open http://127.0.0.1:5173
```

Enter your `ADMIN_API_KEY` on the Connection page; it stays in browser memory only.

### Hosting the console on Netlify

The repo root `netlify.toml` builds `web/` (Node 22, `dist`) with an SPA fallback. On Netlify the
Playground works fully in the browser; the dashboard shows an unavailable state until a HookRelay is
reachable. To connect one, uncomment the proxy rules in `netlify.toml` (the service sends no CORS
headers, so the proxy keeps a single origin). The admin key is never baked into the bundle.

## Limitations

- At-least-once only; there is no exactly-once mode and no ordering guarantee.
- Single admin API key, no users, roles or audit log; no built-in TLS.
- Metrics are per-process JSON counters, not a Prometheus endpoint, and reset on restart.
- Request bodies are limited by `maxBodyBytes` (at most 25 MiB) and compressed request bodies are
  rejected.
- A worker finishes its whole batch before claiming more, so one slow target can delay other
  deliveries in the same batch by up to its timeout; lower `timeoutMs` or run more workers.
- No rate limiting or brute-force protection on `/hooks/*` or `/api/*`; use a reverse proxy.
- Targets are fixed in the config file; changing them needs a restart.
- Forwarding does not copy provider headers (only the content type and `X-HookRelay-*`).
- The WHATWG "bad ports" list applies to targets (for example 6000 and 6667 cannot be used).
- The optional web console (`web/`) is a thin client of the admin API: it adds no endpoints, no roles and no history beyond what the API returns.

## Roadmap

- Prometheus metrics endpoint.
- Optional per-target forwarding of selected provider headers.
- Reload configuration without a restart.
- Additional signature schemes (for example Slack-style versioned signatures).
- Per-target concurrency and rate limits.

## Development

Requires Node 22.19 or newer and a PostgreSQL 16 database for integration tests.

```bash
npm ci                      # also runs `prisma generate`
npm run check               # typecheck, lint, unit tests, build
export DATABASE_URL=postgresql://user:pass@localhost:5432/hookrelay
npm run test:integration    # each test file creates and drops its own schema
npm run test:coverage       # everything, with coverage thresholds
npx prisma migrate dev      # after editing prisma/schema.prisma
```

The console has its own checks: `cd web && npm ci && npm run check`.

Coverage thresholds are 85% overall and 95% for `src/signatures` and `src/delivery`. See
[SPEC.md](SPEC.md) for behaviour and design decisions, [AGENTS.md](AGENTS.md) for contributor and
coding-agent rules, and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
