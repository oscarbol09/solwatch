# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added

- **Solana Engine & Ingestion:**
  - Multi-wallet Solana WebSocket watcher built on `@solana/kit` with exponential backoff and eager stream buffering.
  - Chronological `getSignaturesForAddress` catch-up backfill on reconnect, preventing silent transaction loss during network flaps.
  - Dynamic Associated Token Account (ATA) discovery via `getTokenAccountsByOwner` supporting both classic SPL Token and Token-2022 programs.
  - RPC client with global concurrency semaphore (`AsyncSemaphore`), in-flight coalescing, and LRU response caching for `getTransaction`.
  - Helius Enhanced Webhook adapter (`POST /webhooks/helius`) with fail-closed shared-secret validation.

- **Transaction Classification & Valuation:**
  - Zero-floating-point `BigInt` asset delta engine for native SOL, SPL, and Token-2022 tokens.
  - Automated detection and clean isolation of WSOL wrap/unwrap operations, SPL `closeAccount` rent reclaims, and Jito MEV tips.
  - Protocol-level swap classification across Jupiter (v4/v6), Raydium (AMM/CLMM), Orca, Meteora, and Pump.fun.
  - Zero-cost USD valuation via Jupiter Lite APIs (`$0/mo` infrastructure cost) with circuit-breaker protection and SQLite TTL caching.

- **Storage & Reliability:**
  - Zero-native-compilation storage layer built on Node 24 `node:sqlite` in WAL mode (`busy_timeout = 5000`, `synchronous = NORMAL`).
  - Transactional schema migrations via `PRAGMA user_version` (v1 -> v2 -> v3).
  - Outbox pattern (`alert_outbox`) guaranteeing at-least-once alert delivery with exponential retry backoff and dead-letter handling.
  - Atomic `claimSignatureAndAdvanceCursor` method eliminating `SQLITE_CONSTRAINT_FOREIGNKEY` races during concurrent wallet removals.
  - Monotonic keyset pagination (`listRecentAlerts` with `beforeId`) for delivery audit logs.

- **Alert Rules & Anti-Spam Engine:**
  - Flexible multi-tier rules engine with wallet-specific overrides and fallback global defaults.
  - Threshold filtering across native SOL lamports and estimated USD valuations.
  - Mint allowlists and denylists for suppressing Token-2022 dust airdrops and spam tokens.
  - Bounded LRU `CooldownTracker` evicting oldest timestamps when reaching `MAX_ENTRIES` (10,000 keys).

- **Multi-Channel Dispatch & Security:**
  - Isolated alert dispatcher preventing channel failures from impacting sibling delivery channels.
  - Telegram bot (`grammy`) supporting interactive commands (`/watch`, `/list`, `/rules`, `/pause`, `/resume`, `/setmin`, `/denylist`, `/test`, `/status`), inline buttons, and forum topic routing (`TELEGRAM_ALERT_THREAD_ID`).
  - Discord rich embed formatter with markdown phishing sanitization and disabled mentions.
  - Generic JSON webhooks (version 1.1) cryptographically signed via timestamped HMAC-SHA256 headers (`X-Solwatch-Signature`, `X-Solwatch-Timestamp`).
  - Comprehensive SSRF defenses blocking private IPv4/IPv6 ranges, IMDS `169.254.169.254`, and DNS multi-record rebinding.

- **Control Plane, Dashboard & Observability:**
  - Embedded real-time web console at `GET /` featuring Server-Sent Events (SSE) and strict CSP nonces.
  - Interactive OpenAPI 3.1 documentation explorer at `GET /docs` and `GET /openapi.json`.
  - Service readiness probe (`GET /readyz`) and container liveness probe (`GET /healthz`).
  - Native Prometheus RED exporter at `GET /metrics` with 11-bucket duration histograms and route normalization.
  - Online hot SQLite WAL backup utility (`npm run backup`) using parameterized `VACUUM INTO ?`.

- **Quality Assurance, CI/CD & Documentation:**
  - Vitest test suite achieving **94.7% line coverage** and **83.6% branch coverage** across 20 suites and 118 unit/integration tests.
  - Property-based testing and fuzzing suites using `fast-check`.
  - Concurrency test suite validating race resilience on parallel wallet removals and outbox processing.
  - Hardened GitHub Actions CI with 40-character commit SHA pinning, Gitleaks secret scanning, Trivy container vulnerability audits, and JUnit XML test artifacts.
  - Comprehensive technical guides: `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, and `docs/API.md`.
