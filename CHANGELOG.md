# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added

- Multi-wallet Solana WebSocket watcher built on `@solana/kit` with exponential backoff and chronological `getSignaturesForAddress` catch-up backfill on reconnect.
- Transaction classifier for native SOL transfers (net of fee), SPL / Token-2022 transfers, DEX swaps (Jupiter, Raydium, Orca, Meteora, Pump.fun), and generic program interactions using exact `BigInt` math.
- Helius Enhanced Webhook adapter (`POST /webhooks/helius`) with shared-secret validation.
- Alert rules engine supporting per-wallet overrides, minimum SOL thresholds, event-type filters, mint allow/deny lists, failed transaction suppression, and per-wallet/event cooldown windows.
- Zero-native-build persistence layer using Node 24 `node:sqlite` in WAL mode for watched wallets, cursor tracking, idempotent signature deduplication, and delivery audit logs.
- Multi-channel alert dispatchers with isolated fan-out for Telegram HTML (with Solscan inline button), Discord embeds, HMAC-SHA256 signed webhooks, and terminal output.
- Interactive Telegram management bot (`grammy`) and HTTP control plane (`hono`) with `/healthz` and bearer-token protection.
- Zero-config offline replay demo (`npm run demo`) and live devnet/mainnet mode (`--live <wallet>`).
- Multi-stage non-root Docker build, Docker Compose setup, and GitHub Actions CI workflow.
