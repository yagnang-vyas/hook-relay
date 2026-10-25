# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release.

### Added

- Webhook ingestion at `POST /hooks/:sourceId` with HMAC-SHA256 verification (`sha256=hex`, `hex`,
  `base64`) and Stripe-style timestamped signatures with tolerance, multiple `v1` values and secret
  rotation, always over the raw body bytes.
- Duplicate detection on `(source, delivery ID)` backed by a unique constraint, with generated IDs
  when the provider sends none.
- Transactional persistence of each event and its deliveries in PostgreSQL.
- Delivery workers claiming with `FOR UPDATE SKIP LOCKED`, leases and crash recovery, exponential
  backoff with full jitter, dead-letter handling, and an `X-HookRelay-Signature` on forwarded requests.
- SSRF protection that validates resolved addresses before the request and again at connect time.
- Admin API: event listing and inspection, replay, dead-letter listing, manual retry, metrics.
- Hourly body retention, graceful shutdown, health and readiness endpoints, request IDs and
  structured logs with redaction.
- `openapi.yaml` (OpenAPI 3.1) with tests that keep it in sync with the implementation.
- Docker image, `compose.yaml`, a demo echo target, and GitHub Actions CI.
