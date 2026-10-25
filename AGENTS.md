# Guidance for coding agents

HookRelay is a TypeScript (strict, ESM) service on Node 22+, Express 5, Prisma 7 and PostgreSQL.
Read `SPEC.md` first; it records the behaviour and the decisions that shaped it.

## Commands

| Command                    | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `npm run check`            | typecheck, lint (ESLint + Prettier), unit tests, build     |
| `npm run test`             | unit tests only (no database needed)                       |
| `npm run test:integration` | integration tests; requires `DATABASE_URL` to a PostgreSQL |
| `npm run test:coverage`    | unit and integration tests with coverage thresholds        |
| `npm run db:migrate`       | apply migrations (`prisma migrate deploy`)                 |

Integration tests create a fresh schema per test file, so `DATABASE_URL` can point at any database
you own; they never touch the `public` schema.

## Rules

- Never weaken or skip a test, silence the type checker or linter without a justification comment,
  or lower a coverage threshold. Fix the cause.
- Webhook secrets come from environment variables only. Never log secrets, signatures,
  `Authorization` headers or payload bodies, and extend the redaction test when adding log fields.
- Signature verification must use the raw body bytes. Do not mount a JSON parser before it.
- Every database write that spans tables must be a single transaction.
- The delivery claim query must keep `FOR UPDATE SKIP LOCKED`; completion updates must stay fenced
  on `status = 'in_flight' AND attempts = <claimed attempts>` so a worker that lost its lease cannot
  overwrite a newer attempt.
- Targets come from configuration only, never from a request. Keep the SSRF guard on every outbound
  request.
- Any new route must be added to `openapi.yaml`; a test fails if a route is undocumented.
- Fixtures are synthetic. Do not paste real provider payloads.
- Use exact dependency versions and record library-specific choices under "Decisions" in `SPEC.md`.
- Commits follow Conventional Commits.

## Layout

See the structure table in `SPEC.md`. Tests live in `test/unit` (no I/O) and `test/integration`
(real PostgreSQL, local `node:http` fake targets).
