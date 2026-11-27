# Contributing to Solwatch

Thank you for your interest in contributing to **Solwatch**! We welcome bug reports, documentation improvements, and pull requests from developers building reliable Solana infrastructure.

---

## 1. Getting Started for New Contributors

Looking for a good place to jump in? Browse our open contributor issues:

- **[Good First Issues](https://github.com/oscarbol09/solwatch/labels/good%20first%20issue)** — Self-contained tasks ideal for a first PR.
- **[Help Wanted Issues](https://github.com/oscarbol09/solwatch/labels/help%20wanted)** — Full list of open issues ready for community contributions.
- **[GitHub Discussions](https://github.com/oscarbol09/solwatch/discussions)** — Ask setup questions or propose larger changes before opening a PR.

All contributors are expected to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 2. Core Architectural Guidelines

Before writing code or opening a PR, please keep these invariants in mind:

1. **Strictly Read-Only Scope (Zero Key Custody):**
   `solwatch` is an alert engine and treasury monitor. It must **never** hold private keys, request wallet signatures, or execute on-chain transactions.

2. **Zero Cloud Infrastructure Cost (`$0/mo`):**
   Persistence runs on Node 24 native `node:sqlite` in WAL mode (`DatabaseSync`).
   - Do **not** introduce external database dependencies (Redis, PostgreSQL, MongoDB).
   - Do **not** introduce native C++ build dependencies (`node-gyp`).

3. **Exact `BigInt` Precision for Lamports & SPL Tokens:**
   JavaScript `Number` loses precision on 64-bit integer amounts. Always use `BigInt` for lamports, raw token amounts, and slot numbers until final display formatting.

4. **Resilient Network Decoupling & Deduplication:**
   Public RPC WebSockets disconnect frequently. Listeners must handle reconnects with backoff, catch up via chronological RPC queries, and deduplicate transaction signatures through the SQLite WAL store.

---

## 3. Local Development & Setup

### Prerequisites

- **Node.js**: `>= 24.0.0` (required for native `node:sqlite`)
- **npm**: `>= 10.0.0`
- **Git**: `>= 2.30.0`

### Clone & Install

```bash
git clone https://github.com/oscarbol09/solwatch.git
cd solwatch

npm install
cp .env.example .env
```

### Running Tests & Quality Gates

```bash
# Run Vitest unit and integration suite (with MSW network mocks)
npm test

# Run test suite with coverage report
npm run test:coverage

# Run TypeScript strict type-checking
npm run typecheck

# Check formatting and linting via Biome
npm run lint

# Build compiled output
npm run build
```

### Running Locally

```bash
# Start in development mode
npm run dev

# Start with pretty-printed Pino logs
npm run dev:pretty

# Run the offline replay demo
npm run demo
```

---

## 4. Implementing Features

### Adding a New Alert Channel

1. Implement the `Notifier` interface defined in `src/notifiers/types.ts`:

   ```typescript
   import type { AlertEnvelope, Notifier } from "./types.js";

   export class CustomNotifier implements Notifier {
     readonly channel = "custom";

     async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
       // Dispatch alert using signal for cancellation/timeouts
     }
   }
   ```

2. Wire your notifier into `notifiers` in `src/index.ts` (passed to `AlertDispatcher` in `src/notifiers/dispatcher.ts`).
3. Add MSW contract tests in `tests/integration/notifiers.test.ts` covering payload formatting, timeouts, and retries.

### Adding a DEX Parser or Program Filter

1. Register protocol IDs in `DEX_PROGRAMS` inside `src/domain/classifier.ts`.
2. Verify classification output in `classifyParsedTransaction()`.
3. Add unit test fixtures in `tests/unit/classifier.test.ts`.

---

## 5. Commit & Pull Request Guidelines

### Commit Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(alerts): add discord webhook notifier with rate-limit backoff`
- `fix(rpc): prevent duplicate signature insertion during reconnect catch-up`
- `docs(api): document inbound helius webhook signature verification`
- `test(classifier): add raydium clmm swap test fixture`

### Pull Request Checklist

1. **One Concern per PR:** Keep pull requests focused on a single issue or feature.
2. **Quality Gates Must Pass:** Confirm `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` succeed before marking a PR ready.
3. **No Secrets:** Never commit real API keys, Telegram bot tokens, or private endpoints in fixtures or code.
4. **Docs in Sync:** Update `README.md`, `docs/API.md`, or `docs/ARCHITECTURE.md` if configuration or routes change.
