# HookRelay specification

HookRelay is a self-hosted service that receives webhooks, verifies their signatures, stores them
durably in PostgreSQL, forwards them to configured internal targets with retries, and lets
operators inspect and replay them.

## Goals

- Never lose an accepted webhook because a downstream service is unavailable.
- Reject forged or replayed requests before they reach storage.
- Make every event and delivery attempt inspectable and replayable.
- Be safe to run with several workers against one database.

## Non-goals (v0.1.0)

A web UI, payload transformation, multi-tenant auth, Redis or a message broker (PostgreSQL is the
queue), provider-specific SDKs, and autoscaling guidance beyond "multiple workers are safe".

## Delivery semantics

HookRelay provides **at-least-once** delivery. A target may receive the same event more than once
(for example when a worker crashes after the target responded but before the result was recorded,
or after a manual replay). Targets must deduplicate on the `X-HookRelay-Event-Id` header.
Ordering between events is not guaranteed.

## Components

| Area       | Module                                | Responsibility                                      |
| ---------- | ------------------------------------- | --------------------------------------------------- |
| Config     | `src/config.ts`                       | Validate environment and `hookrelay.config.json`    |
| Signatures | `src/signatures/`                     | Pure verification of HMAC schemes over the raw body |
| Ingest     | `src/routes/ingest.ts`                | `POST /hooks/:sourceId`                             |
| Storage    | `src/store/`                          | Prisma access for events, deliveries and attempts   |
| Delivery   | `src/delivery/`                       | Claiming, forwarding, backoff, SSRF guard, leases   |
| Admin API  | `src/routes/admin.ts`                 | Inspection, replay, dead-letter handling            |
| Operations | `src/retention.ts`, `src/shutdown.ts` | Body retention, graceful shutdown                   |

The HTTP contract is described in `openapi.yaml`.

## Decisions

Decisions are recorded where the brief was ambiguous or where a library choice needed
justification. The most conservative reading was taken in each case.

### Tooling and versions

- **Prisma 7.10.1, not the `latest` dist-tag.** At the time of writing, npm's `latest` tag for
  `prisma` points at an 8.0 release candidate, so the newest stable 7.x release is pinned instead.
  Prisma 7 requires a driver adapter (`@prisma/adapter-pg`), a `prisma.config.ts` that supplies the
  datasource URL, and the new `prisma-client` generator, which writes the client into
  `src/generated/prisma` (git-ignored, produced by `prisma generate`).
- **TypeScript 6.0.3, not 7.x.** `typescript-eslint` 8.x declares a peer range of
  `typescript <6.1.0`; type-aware linting is a requirement, so the newest compatible compiler is used.
- **Express 5.** Async route handlers propagate rejections to the error handler without wrappers.
- **Pinned versions.** Every dependency in `package.json` is an exact version.

### Configuration

- Configuration is validated with strict zod schemas: unknown keys are errors, so typos fail startup
  instead of being silently ignored. All problems are reported together.
- `ADMIN_API_KEY` and `RELAY_SIGNING_SECRET` must be at least 16 characters.
- A target's `timeoutMs` must be at least 5 seconds shorter than `LEASE_SECONDS`, otherwise a healthy
  in-flight request could outlive its lease and be delivered twice. Startup fails if it is not.
- `network.allowPrivateTargets` entries are matched case-insensitively against the target hostname
  (exact match, no wildcards).
- Target URLs must not contain credentials.

### Request handling

- Every response from an error path uses `{ "error": { "code", "message", "requestId" } }`,
  including 404s for unknown routes and body-parser failures.
- An inbound `X-Request-Id` is only honoured if it matches `[A-Za-z0-9._-]{1,128}`; otherwise a UUID
  is generated. This prevents log injection through the header.
- Request logs record method, route template, status and duration only. Headers, query strings and
  bodies are never logged. Logger redaction is configured as a second line of defence, and
  database-client errors are reduced to their type and code because they can echo query arguments.
- Readiness (`/readyz`) is true only if the database answers and every migration directory shipped
  with the build is recorded as successfully applied in `_prisma_migrations`.
- An in-process counter set exists (`invalid_signatures_total` and others). It is exposed through the
  authenticated `GET /api/metrics` endpoint rather than a public, unauthenticated one.
