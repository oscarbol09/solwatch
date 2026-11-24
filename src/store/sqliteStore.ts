import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { ConflictError } from "../domain/errors.js";
import {
  type AlertRule,
  deserializeOnChainEvent,
  type EventType,
  type MintAddress,
  type OnChainEvent,
  parseMintAddress,
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
  type RuleId,
  serializeOnChainEvent,
  type TxSignature,
  type WalletAddress,
  type WatchedWallet,
} from "../domain/types.js";

const EventTypeSchema = z.enum(["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"]);
const NullableIntOrBigIntSchema = z
  .union([z.number().int(), z.bigint()])
  .nullable()
  .transform((val) => (val === null ? null : BigInt(val)));
const IntOrBigIntSchema = z.union([z.number().int(), z.bigint()]).transform((val) => BigInt(val));

const WalletRowSchema = z.object({
  address: z.string(),
  label: z.string().nullable(),
  enabled: z.number().int(),
  last_signature: z.string().nullable(),
  last_slot: NullableIntOrBigIntSchema,
  last_rpc_signature: z.string().nullable(),
  last_rpc_slot: NullableIntOrBigIntSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const RuleRowSchema = z.object({
  id: z.string(),
  wallet_address: z.string().nullable(),
  min_sol_lamports: z.string(),
  min_usd: z.number().nullable().optional().default(null),
  event_types_json: z.string(),
  mint_allowlist_json: z.string(),
  mint_denylist_json: z.string(),
  include_failed: z.number().int(),
  cooldown_seconds: z.number().int(),
  enabled: z.number().int(),
  managed_by_env: z.number().int(),
});

const TokenMetadataRowSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  usd_price: z.number().nullable(),
  price_updated_at_ms: z.number().int().nullable(),
  updated_at_ms: z.number().int(),
});

const DeliveryRowSchema = z.object({
  id: z.number().int(),
  wallet_address: z.string(),
  signature: z.string(),
  event_kind: EventTypeSchema,
  summary: z.string(),
  channel: z.string(),
  status: z.enum(["sent", "failed"]),
  error_message: z.string().nullable(),
  delivered_at: z.string(),
});

const OutboxRowSchema = z.object({
  id: z.number().int(),
  delivery_id: z.string(),
  wallet_address: z.string(),
  wallet_label: z.string().nullable(),
  signature: z.string(),
  event_kind: EventTypeSchema,
  event_json: z.string(),
  channel: z.string(),
  status: z.enum(["pending", "sent", "dead_letter"]),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  next_retry_at_ms: z.number().int(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PendingSignatureRowSchema = z.object({
  wallet_address: z.string(),
  signature: z.string(),
  slot: IntOrBigIntSchema,
  source: z.enum(["websocket", "backfill"]),
  advance_rpc_cursor: z.number().int(),
  attempts: z.number().int(),
  next_retry_at_ms: z.number().int(),
  created_at: z.string(),
});

const TableInfoRowSchema = z.object({
  name: z.string(),
  type: z.string(),
});

export type AlertDeliveryRecord = {
  readonly id: number;
  readonly walletAddress: WalletAddress;
  readonly signature: TxSignature;
  readonly eventKind: EventType;
  readonly summary: string;
  readonly channel: string;
  readonly status: "sent" | "failed";
  readonly errorMessage: string | null;
  readonly deliveredAt: string;
};

export type NewDeliveryRecord = {
  readonly walletAddress: WalletAddress;
  readonly signature: TxSignature;
  readonly eventKind: EventType;
  readonly summary: string;
  readonly channel: string;
  readonly status: "sent" | "failed";
  readonly errorMessage?: string | null | undefined;
};

export type AlertOutboxItem = {
  readonly id: number;
  readonly deliveryId: string;
  readonly walletAddress: WalletAddress;
  readonly walletLabel: string | null;
  readonly signature: TxSignature;
  readonly eventKind: EventType;
  readonly event: OnChainEvent;
  readonly channel: string;
  readonly status: "pending" | "sent" | "dead_letter";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextRetryAtMs: number;
  readonly lastError: string | null;
};

export type NewOutboxItem = {
  readonly deliveryId: string;
  readonly walletAddress: WalletAddress;
  readonly walletLabel: string | null;
  readonly signature: TxSignature;
  readonly event: OnChainEvent;
  readonly channel: string;
  readonly nextRetryAtMs: number;
  readonly lastError: string | null;
  readonly maxAttempts?: number | undefined;
};

export type PendingSignatureItem = {
  readonly walletAddress: WalletAddress;
  readonly signature: TxSignature;
  readonly slot: bigint;
  readonly source: "websocket" | "backfill";
  readonly advanceRpcCursor: boolean;
  readonly attempts: number;
  readonly nextRetryAtMs: number;
};

export type ClaimSignatureResult =
  | { readonly status: "unwatched" }
  | { readonly status: "paused" }
  | { readonly status: "deduped" }
  | {
      readonly status: "claimed";
      readonly walletLabel: string | null;
      readonly walletEnabled: boolean;
    };

export type ListRecentAlertsOptions = {
  readonly beforeId?: number | undefined;
  readonly status?: "sent" | "failed" | undefined;
  readonly channel?: string | undefined;
};

export type PruneHistoryResult = {
  readonly processedDeleted: number;
  readonly deliveriesDeleted: number;
};

export type CachedTokenMetadata = {
  readonly mint: MintAddress;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly usdPrice: number | null;
  readonly priceUpdatedAtMs: number | null;
  readonly updatedAtMs: number;
};

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS watched_wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_signature TEXT,
  last_slot INTEGER,
  last_rpc_signature TEXT,
  last_rpc_slot INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  wallet_address TEXT REFERENCES watched_wallets(address) ON DELETE CASCADE,
  min_sol_lamports TEXT NOT NULL,
  min_usd REAL,
  event_types_json TEXT NOT NULL,
  mint_allowlist_json TEXT NOT NULL,
  mint_denylist_json TEXT NOT NULL,
  include_failed INTEGER NOT NULL DEFAULT 0,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  managed_by_env INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS processed_signatures (
  wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (wallet_address, signature)
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id INTEGER PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  delivered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_outbox (
  id INTEGER PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
  wallet_label TEXT,
  signature TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at_ms INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wallet_address, signature, channel)
);

CREATE TABLE IF NOT EXISTS rule_cooldowns (
  rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  last_triggered_ms INTEGER NOT NULL,
  PRIMARY KEY (rule_id, wallet_address, event_kind)
);

CREATE TABLE IF NOT EXISTS pending_signatures (
  wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('websocket', 'backfill')),
  advance_rpc_cursor INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet_address, signature)
);

CREATE TABLE IF NOT EXISTS token_metadata (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  usd_price REAL,
  price_updated_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_watched_wallets_enabled_created
  ON watched_wallets (enabled, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_rules_wallet
  ON alert_rules (wallet_address);
CREATE INDEX IF NOT EXISTS idx_processed_signatures_time
  ON processed_signatures (processed_at);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_wallet_time
  ON alert_deliveries (wallet_address, id DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_time
  ON alert_deliveries (delivered_at);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_due
  ON alert_outbox (status, next_retry_at_ms);
CREATE INDEX IF NOT EXISTS idx_pending_signatures_due
  ON pending_signatures (next_retry_at_ms);
`;

type PreparedStatements = {
  readonly ping: StatementSync;
  readonly getJournalMode: StatementSync;
  readonly getUserVersion: StatementSync;
  readonly createWallet: StatementSync;
  readonly updateWallet: StatementSync;
  readonly removeWallet: StatementSync;
  readonly getWallet: StatementSync;
  readonly getWalletClaimState: StatementSync;
  readonly listWalletsAll: StatementSync;
  readonly listWalletsEnabled: StatementSync;
  readonly countWalletsAll: StatementSync;
  readonly countWalletsEnabled: StatementSync;
  readonly updateLastSigUnbounded: StatementSync;
  readonly updateLastSigMonotonic: StatementSync;
  readonly updateLastRpcSigMonotonic: StatementSync;
  readonly upsertRule: StatementSync;
  readonly getRule: StatementSync;
  readonly getRuleManagedByEnv: StatementSync;
  readonly deleteRule: StatementSync;
  readonly listRulesGlobal: StatementSync;
  readonly listRulesForWallet: StatementSync;
  readonly listAllRules: StatementSync;
  readonly getTokenMetadata: StatementSync;
  readonly upsertTokenMetadata: StatementSync;
  readonly insertProcessedSignature: StatementSync;
  readonly recordDelivery: StatementSync;
  readonly upsertOutboxItem: StatementSync;
  readonly listDueOutboxItems: StatementSync;
  readonly markOutboxSent: StatementSync;
  readonly rescheduleOutboxItem: StatementSync;
  readonly countPendingOutbox: StatementSync;
  readonly getRuleCooldown: StatementSync;
  readonly setRuleCooldown: StatementSync;
  readonly upsertPendingSignature: StatementSync;
  readonly listDuePendingSignatures: StatementSync;
  readonly reschedulePendingSignature: StatementSync;
  readonly deletePendingSignature: StatementSync;
  readonly countPendingSignatures: StatementSync;
  readonly pruneProcessedBatch: StatementSync;
  readonly pruneDeliveriesBatch: StatementSync;
};

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly fileBacked: boolean;
  private readonly stmts: PreparedStatements;
  private txDepth = 0;
  private closed = false;
  private walletCatalogVersion = 0;

  constructor(dbPath: string, now: () => Date = () => new Date()) {
    this.now = now;
    const isUri = dbPath.startsWith("file:");
    this.fileBacked = dbPath !== ":memory:";

    if (this.fileBacked && !isUri) {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }

    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });

    if (this.fileBacked && !isUri && process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }

    if (this.fileBacked) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -64000;
        PRAGMA temp_store = MEMORY;
        PRAGMA journal_size_limit = 67108864;
        PRAGMA wal_autocheckpoint = 1000;
      `);
    }

    this.runMigrations();
    this.stmts = this.prepareAllStatements();
  }

  private runMigrations(): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get();
    const currentVersion = z
      .object({ user_version: z.number().int() })
      .parse(versionRow).user_version;

    if (currentVersion >= 3) {
      return;
    }

    this.inTransaction(() => {
      this.db.exec(BASE_SCHEMA_SQL);

      const walletCols = new Set(
        this.db
          .prepare("PRAGMA table_info(watched_wallets)")
          .all()
          .map((row) => TableInfoRowSchema.parse(row).name),
      );
      if (!walletCols.has("last_slot")) {
        this.db.exec("ALTER TABLE watched_wallets ADD COLUMN last_slot INTEGER;");
      }
      if (!walletCols.has("last_rpc_signature")) {
        this.db.exec("ALTER TABLE watched_wallets ADD COLUMN last_rpc_signature TEXT;");
      }
      if (!walletCols.has("last_rpc_slot")) {
        this.db.exec("ALTER TABLE watched_wallets ADD COLUMN last_rpc_slot INTEGER;");
      }

      const ruleCols = new Set(
        this.db
          .prepare("PRAGMA table_info(alert_rules)")
          .all()
          .map((row) => TableInfoRowSchema.parse(row).name),
      );
      if (!ruleCols.has("managed_by_env")) {
        this.db.exec(
          "ALTER TABLE alert_rules ADD COLUMN managed_by_env INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (!ruleCols.has("min_usd")) {
        this.db.exec("ALTER TABLE alert_rules ADD COLUMN min_usd REAL;");
      }

      const sigCols = this.db
        .prepare("PRAGMA table_info(processed_signatures)")
        .all()
        .map((row) => TableInfoRowSchema.parse(row));
      const slotCol = sigCols.find((col) => col.name === "slot");
      if (slotCol && slotCol.type.toUpperCase() !== "INTEGER") {
        this.db.exec(`
          CREATE TABLE processed_signatures_v2 (
            wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
            signature TEXT NOT NULL,
            slot INTEGER NOT NULL,
            event_kind TEXT NOT NULL,
            processed_at TEXT NOT NULL,
            PRIMARY KEY (wallet_address, signature)
          );
          INSERT INTO processed_signatures_v2 (wallet_address, signature, slot, event_kind, processed_at)
          SELECT wallet_address, signature, CAST(slot AS INTEGER), event_kind, processed_at
          FROM processed_signatures;
          DROP TABLE processed_signatures;
          ALTER TABLE processed_signatures_v2 RENAME TO processed_signatures;
        `);
      }

      this.db.exec(INDEXES_SQL);
      this.db.exec("PRAGMA user_version = 3;");
    });
  }

  private prepareAllStatements(): PreparedStatements {
    return {
      ping: this.db.prepare("SELECT 1 AS ok"),
      getJournalMode: this.db.prepare("PRAGMA journal_mode"),
      getUserVersion: this.db.prepare("PRAGMA user_version"),
      createWallet: this.db.prepare(
        `INSERT OR IGNORE INTO watched_wallets (
           address, label, enabled, last_signature, last_slot, last_rpc_signature, last_rpc_slot, created_at, updated_at
         ) VALUES (?, ?, 1, NULL, NULL, NULL, NULL, ?, ?)`,
      ),
      updateWallet: this.db.prepare(
        "UPDATE watched_wallets SET label = ?, enabled = ?, updated_at = ? WHERE address = ?",
      ),
      removeWallet: this.db.prepare("DELETE FROM watched_wallets WHERE address = ?"),
      getWallet: this.db.prepare("SELECT * FROM watched_wallets WHERE address = ?"),
      getWalletClaimState: this.db.prepare(
        "SELECT label, enabled FROM watched_wallets WHERE address = ?",
      ),
      listWalletsAll: this.db.prepare("SELECT * FROM watched_wallets ORDER BY created_at ASC"),
      listWalletsEnabled: this.db.prepare(
        "SELECT * FROM watched_wallets WHERE enabled = 1 ORDER BY created_at ASC",
      ),
      countWalletsAll: this.db.prepare("SELECT COUNT(*) AS count FROM watched_wallets"),
      countWalletsEnabled: this.db.prepare(
        "SELECT COUNT(*) AS count FROM watched_wallets WHERE enabled = 1",
      ),
      updateLastSigUnbounded: this.db.prepare(
        `UPDATE watched_wallets
         SET last_signature = ?, last_rpc_signature = ?, updated_at = ?
         WHERE address = ?`,
      ),
      updateLastSigMonotonic: this.db.prepare(
        `UPDATE watched_wallets
         SET last_signature = ?, last_slot = ?, updated_at = ?
         WHERE address = ? AND (last_slot IS NULL OR ? >= last_slot)`,
      ),
      updateLastRpcSigMonotonic: this.db.prepare(
        `UPDATE watched_wallets
         SET last_rpc_signature = ?, last_rpc_slot = ?, updated_at = ?
         WHERE address = ? AND (last_rpc_slot IS NULL OR ? >= last_rpc_slot)`,
      ),
      upsertRule: this.db.prepare(
        `INSERT INTO alert_rules (
           id, wallet_address, min_sol_lamports, min_usd, event_types_json,
           mint_allowlist_json, mint_denylist_json, include_failed, cooldown_seconds, enabled, managed_by_env
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           wallet_address = excluded.wallet_address,
           min_sol_lamports = excluded.min_sol_lamports,
           min_usd = excluded.min_usd,
           event_types_json = excluded.event_types_json,
           mint_allowlist_json = excluded.mint_allowlist_json,
           mint_denylist_json = excluded.mint_denylist_json,
           include_failed = excluded.include_failed,
           cooldown_seconds = excluded.cooldown_seconds,
           enabled = excluded.enabled,
           managed_by_env = excluded.managed_by_env`,
      ),
      getRule: this.db.prepare("SELECT * FROM alert_rules WHERE id = ?"),
      getRuleManagedByEnv: this.db.prepare("SELECT managed_by_env FROM alert_rules WHERE id = ?"),
      deleteRule: this.db.prepare("DELETE FROM alert_rules WHERE id = ?"),
      listRulesGlobal: this.db.prepare("SELECT * FROM alert_rules WHERE wallet_address IS NULL"),
      listRulesForWallet: this.db.prepare(
        "SELECT * FROM alert_rules WHERE wallet_address = ? OR wallet_address IS NULL",
      ),
      listAllRules: this.db.prepare("SELECT * FROM alert_rules"),
      getTokenMetadata: this.db.prepare("SELECT * FROM token_metadata WHERE mint = ?"),
      upsertTokenMetadata: this.db.prepare(
        `INSERT INTO token_metadata (
           mint, symbol, name, decimals, usd_price, price_updated_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET
           symbol = excluded.symbol,
           name = excluded.name,
           decimals = excluded.decimals,
           usd_price = excluded.usd_price,
           price_updated_at_ms = excluded.price_updated_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      ),
      insertProcessedSignature: this.db.prepare(
        `INSERT INTO processed_signatures (wallet_address, signature, slot, event_kind, processed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wallet_address, signature) DO NOTHING`,
      ),
      recordDelivery: this.db.prepare(
        `INSERT INTO alert_deliveries (
           wallet_address, signature, event_kind, summary, channel, status, error_message, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertOutboxItem: this.db.prepare(
        `INSERT INTO alert_outbox (
           delivery_id, wallet_address, wallet_label, signature, event_kind, event_json,
           channel, status, attempts, max_attempts, next_retry_at_ms, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet_address, signature, channel) DO UPDATE SET
           wallet_label = excluded.wallet_label,
           event_json = excluded.event_json,
           status = 'pending',
           next_retry_at_ms = excluded.next_retry_at_ms,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      ),
      listDueOutboxItems: this.db.prepare(
        `SELECT * FROM alert_outbox
         WHERE status = 'pending' AND next_retry_at_ms <= ?
         ORDER BY next_retry_at_ms ASC, id ASC
         LIMIT ?`,
      ),
      markOutboxSent: this.db.prepare(
        `UPDATE alert_outbox SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?`,
      ),
      rescheduleOutboxItem: this.db.prepare(
        `UPDATE alert_outbox
         SET status = ?, attempts = ?, next_retry_at_ms = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ),
      countPendingOutbox: this.db.prepare(
        "SELECT COUNT(*) AS count FROM alert_outbox WHERE status = 'pending'",
      ),
      getRuleCooldown: this.db.prepare(
        `SELECT last_triggered_ms FROM rule_cooldowns
         WHERE rule_id = ? AND wallet_address = ? AND event_kind = ?`,
      ),
      setRuleCooldown: this.db.prepare(
        `INSERT INTO rule_cooldowns (rule_id, wallet_address, event_kind, last_triggered_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(rule_id, wallet_address, event_kind) DO UPDATE SET
           last_triggered_ms = CASE
             WHEN excluded.last_triggered_ms > rule_cooldowns.last_triggered_ms
               THEN excluded.last_triggered_ms
             ELSE rule_cooldowns.last_triggered_ms
           END`,
      ),
      upsertPendingSignature: this.db.prepare(
        `INSERT INTO pending_signatures (
           wallet_address, signature, slot, source, advance_rpc_cursor, attempts, next_retry_at_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet_address, signature) DO UPDATE SET
           slot = CASE WHEN excluded.slot > pending_signatures.slot THEN excluded.slot ELSE pending_signatures.slot END,
           advance_rpc_cursor = MAX(pending_signatures.advance_rpc_cursor, excluded.advance_rpc_cursor)`,
      ),
      listDuePendingSignatures: this.db.prepare(
        `SELECT * FROM pending_signatures
         WHERE next_retry_at_ms <= ?
         ORDER BY next_retry_at_ms ASC
         LIMIT ?`,
      ),
      reschedulePendingSignature: this.db.prepare(
        `UPDATE pending_signatures SET attempts = ?, next_retry_at_ms = ?
         WHERE wallet_address = ? AND signature = ?`,
      ),
      deletePendingSignature: this.db.prepare(
        "DELETE FROM pending_signatures WHERE wallet_address = ? AND signature = ?",
      ),
      countPendingSignatures: this.db.prepare("SELECT COUNT(*) AS count FROM pending_signatures"),
      pruneProcessedBatch: this.db.prepare(
        `DELETE FROM processed_signatures
         WHERE rowid IN (
           SELECT rowid FROM processed_signatures WHERE processed_at < ? LIMIT ?
         )`,
      ),
      pruneDeliveriesBatch: this.db.prepare(
        `DELETE FROM alert_deliveries
         WHERE id IN (
           SELECT id FROM alert_deliveries WHERE delivered_at < ? LIMIT ?
         )`,
      ),
    };
  }

  inTransaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    if (depth === 0) {
      this.db.exec("BEGIN IMMEDIATE;");
    } else {
      this.db.exec(`SAVEPOINT sp_${depth};`);
    }
    this.txDepth += 1;

    try {
      const result = fn();
      if (depth === 0) {
        this.db.exec("COMMIT;");
      } else {
        this.db.exec(`RELEASE SAVEPOINT sp_${depth};`);
      }
      return result;
    } catch (err) {
      if (depth === 0) {
        this.db.exec("ROLLBACK;");
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT sp_${depth}; RELEASE SAVEPOINT sp_${depth};`);
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  getJournalMode(): string {
    const row = this.stmts.getJournalMode.get();
    return z.object({ journal_mode: z.string() }).parse(row).journal_mode;
  }

  getSchemaVersion(): number {
    const row = this.stmts.getUserVersion.get();
    return z.object({ user_version: z.number().int() }).parse(row).user_version;
  }

  ping(): boolean {
    if (this.closed) return false;
    try {
      const row = this.stmts.ping.get();
      return z.object({ ok: z.literal(1) }).safeParse(row).success;
    } catch {
      return false;
    }
  }

  createWallet(address: WalletAddress, label: string | null = null): WatchedWallet {
    const timestamp = this.now().toISOString();
    const result = this.stmts.createWallet.run(address, label, timestamp, timestamp);

    if (Number(result.changes) === 0) {
      throw new ConflictError(`Wallet ${address} is already watched`, { address });
    }
    this.walletCatalogVersion += 1;
    const created = this.getWallet(address);
    if (!created) {
      throw new Error(`Failed to reload wallet ${address} after insert`);
    }
    return created;
  }

  updateWallet(
    address: WalletAddress,
    patch: { readonly label?: string | null | undefined; readonly enabled?: boolean | undefined },
  ): WatchedWallet | null {
    const existing = this.getWallet(address);
    if (!existing) return null;

    const nextLabel = patch.label !== undefined ? patch.label : existing.label;
    const nextEnabled =
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
    const timestamp = this.now().toISOString();

    this.stmts.updateWallet.run(nextLabel, nextEnabled, timestamp, address);

    this.walletCatalogVersion += 1;
    return this.getWallet(address);
  }

  removeWallet(address: WalletAddress): boolean {
    const result = this.stmts.removeWallet.run(address);
    const removed = Number(result.changes) > 0;
    if (removed) {
      this.walletCatalogVersion += 1;
    }
    return removed;
  }

  getWalletCatalogVersion(): number {
    return this.walletCatalogVersion;
  }

  getWallet(address: WalletAddress): WatchedWallet | null {
    const row = this.stmts.getWallet.get(address);
    return row ? this.mapWalletRow(row) : null;
  }

  listWallets(enabledOnly: boolean = false): readonly WatchedWallet[] {
    const rows = enabledOnly
      ? this.stmts.listWalletsEnabled.all()
      : this.stmts.listWalletsAll.all();
    return rows.map((row) => this.mapWalletRow(row));
  }

  countWallets(enabledOnly: boolean = false): number {
    const row = enabledOnly
      ? this.stmts.countWalletsEnabled.get()
      : this.stmts.countWalletsAll.get();
    return z.object({ count: z.number().int() }).parse(row).count;
  }

  updateLastSignature(
    address: WalletAddress,
    signature: TxSignature,
    slot?: bigint,
    options: { readonly advanceRpcCursor?: boolean | undefined } = {},
  ): void {
    const timestamp = this.now().toISOString();
    if (slot === undefined) {
      this.stmts.updateLastSigUnbounded.run(signature, signature, timestamp, address);
      return;
    }

    const advanceRpcCursor = options.advanceRpcCursor ?? true;
    this.inTransaction(() => {
      this.stmts.updateLastSigMonotonic.run(signature, slot, timestamp, address, slot);
      if (advanceRpcCursor) {
        this.stmts.updateLastRpcSigMonotonic.run(signature, slot, timestamp, address, slot);
      }
    });
  }

  upsertRule(rule: AlertRule, options: { readonly managedByEnv?: boolean | undefined } = {}): void {
    const managedByEnv = options.managedByEnv ? 1 : 0;
    this.stmts.upsertRule.run(
      rule.id,
      rule.walletAddress,
      rule.minSolLamports.toString(),
      rule.minUsd ?? null,
      JSON.stringify(rule.eventTypes),
      JSON.stringify(rule.mintAllowlist),
      JSON.stringify(rule.mintDenylist),
      rule.includeFailed ? 1 : 0,
      rule.cooldownSeconds,
      rule.enabled ? 1 : 0,
      managedByEnv,
    );
  }

  getRule(id: RuleId): AlertRule | null {
    const row = this.stmts.getRule.get(id);
    return row ? this.mapRuleRow(row) : null;
  }

  getTokenMetadata(mint: MintAddress): CachedTokenMetadata | null {
    const row = this.stmts.getTokenMetadata.get(mint);
    if (!row) return null;
    const parsed = TokenMetadataRowSchema.parse(row);
    return {
      mint: parseMintAddress(parsed.mint),
      symbol: parsed.symbol,
      name: parsed.name,
      decimals: parsed.decimals,
      usdPrice: parsed.usd_price,
      priceUpdatedAtMs: parsed.price_updated_at_ms,
      updatedAtMs: parsed.updated_at_ms,
    };
  }

  upsertTokenMetadata(entry: CachedTokenMetadata): void {
    this.stmts.upsertTokenMetadata.run(
      entry.mint,
      entry.symbol,
      entry.name,
      entry.decimals,
      entry.usdPrice,
      entry.priceUpdatedAtMs,
      entry.updatedAtMs,
    );
  }

  isRuleManagedByEnv(id: RuleId): boolean {
    const row = this.stmts.getRuleManagedByEnv.get(id);
    if (!row) return false;
    return z.object({ managed_by_env: z.number().int() }).parse(row).managed_by_env === 1;
  }

  deleteRule(id: RuleId): boolean {
    const result = this.stmts.deleteRule.run(id);
    return Number(result.changes) > 0;
  }

  listRulesForWallet(walletAddress: WalletAddress | null): readonly AlertRule[] {
    const rows =
      walletAddress === null
        ? this.stmts.listRulesGlobal.all()
        : this.stmts.listRulesForWallet.all(walletAddress);
    return rows.map((row) => this.mapRuleRow(row));
  }

  listAllRules(): readonly AlertRule[] {
    const rows = this.stmts.listAllRules.all();
    return rows.map((row) => this.mapRuleRow(row));
  }

  tryMarkSignatureProcessed(
    wallet: WalletAddress,
    signature: TxSignature,
    slot: bigint,
    eventKind: EventType,
  ): boolean {
    return this.inTransaction(() => {
      if (!this.stmts.getWalletClaimState.get(wallet)) {
        return false;
      }
      const timestamp = this.now().toISOString();
      const result = this.stmts.insertProcessedSignature.run(
        wallet,
        signature,
        slot,
        eventKind,
        timestamp,
      );
      return Number(result.changes) === 1;
    });
  }

  claimSignatureAndAdvanceCursor(params: {
    readonly wallet: WalletAddress;
    readonly signature: TxSignature;
    readonly slot: bigint;
    readonly eventKind: EventType;
    readonly advanceRpcCursor: boolean;
  }): ClaimSignatureResult {
    return this.inTransaction(() => {
      const walletRow = this.stmts.getWalletClaimState.get(params.wallet);
      if (!walletRow) {
        return { status: "unwatched" };
      }

      const parsedWallet = z
        .object({ label: z.string().nullable(), enabled: z.number().int() })
        .parse(walletRow);

      if (parsedWallet.enabled !== 1) {
        this.stmts.deletePendingSignature.run(params.wallet, params.signature);
        return { status: "paused" };
      }

      const timestamp = this.now().toISOString();
      const insertRes = this.stmts.insertProcessedSignature.run(
        params.wallet,
        params.signature,
        params.slot,
        params.eventKind,
        timestamp,
      );

      this.stmts.deletePendingSignature.run(params.wallet, params.signature);

      if (Number(insertRes.changes) === 0) {
        return { status: "deduped" };
      }

      this.stmts.updateLastSigMonotonic.run(
        params.signature,
        params.slot,
        timestamp,
        params.wallet,
        params.slot,
      );

      if (params.advanceRpcCursor) {
        this.stmts.updateLastRpcSigMonotonic.run(
          params.signature,
          params.slot,
          timestamp,
          params.wallet,
          params.slot,
        );
      }

      return {
        status: "claimed",
        walletLabel: parsedWallet.label,
        walletEnabled: parsedWallet.enabled === 1,
      };
    });
  }

  recordDelivery(entry: NewDeliveryRecord): void {
    const timestamp = this.now().toISOString();
    this.stmts.recordDelivery.run(
      entry.walletAddress,
      entry.signature,
      entry.eventKind,
      entry.summary,
      entry.channel,
      entry.status,
      entry.errorMessage ?? null,
      timestamp,
    );
  }

  recordDeliveriesBatch(entries: readonly NewDeliveryRecord[]): void {
    if (entries.length === 0) return;
    const timestamp = this.now().toISOString();
    this.inTransaction(() => {
      for (const entry of entries) {
        this.stmts.recordDelivery.run(
          entry.walletAddress,
          entry.signature,
          entry.eventKind,
          entry.summary,
          entry.channel,
          entry.status,
          entry.errorMessage ?? null,
          timestamp,
        );
      }
    });
  }

  listRecentAlerts(
    limit: number = 25,
    walletAddress?: WalletAddress,
    options: ListRecentAlertsOptions = {},
  ): readonly AlertDeliveryRecord[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (walletAddress !== undefined) {
      conditions.push("wallet_address = ?");
      params.push(walletAddress);
    }
    if (options.beforeId !== undefined) {
      conditions.push("id < ?");
      params.push(options.beforeId);
    }
    if (options.status !== undefined) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.channel !== undefined) {
      conditions.push("channel = ?");
      params.push(options.channel);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM alert_deliveries ${whereSql} ORDER BY id DESC LIMIT ?`;
    params.push(bounded);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      const parsed = DeliveryRowSchema.parse(row);
      return {
        id: parsed.id,
        walletAddress: parseWalletAddress(parsed.wallet_address),
        signature: parseTxSignature(parsed.signature),
        eventKind: parsed.event_kind,
        summary: parsed.summary,
        channel: parsed.channel,
        status: parsed.status,
        errorMessage: parsed.error_message,
        deliveredAt: parsed.delivered_at,
      };
    });
  }

  enqueueOutboxItems(items: readonly NewOutboxItem[]): void {
    if (items.length === 0) return;
    const timestamp = this.now().toISOString();
    this.inTransaction(() => {
      for (const item of items) {
        if (!this.stmts.getWalletClaimState.get(item.walletAddress)) continue;
        this.stmts.upsertOutboxItem.run(
          item.deliveryId,
          item.walletAddress,
          item.walletLabel,
          item.signature,
          item.event.kind,
          serializeOnChainEvent(item.event),
          item.channel,
          item.maxAttempts ?? 5,
          item.nextRetryAtMs,
          item.lastError,
          timestamp,
          timestamp,
        );
      }
    });
  }

  listDueOutboxItems(nowMs: number, limit: number = 25): readonly AlertOutboxItem[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.stmts.listDueOutboxItems.all(nowMs, bounded);
    return rows.map((raw) => {
      const row = OutboxRowSchema.parse(raw);
      return {
        id: row.id,
        deliveryId: row.delivery_id,
        walletAddress: parseWalletAddress(row.wallet_address),
        walletLabel: row.wallet_label,
        signature: parseTxSignature(row.signature),
        eventKind: row.event_kind,
        event: deserializeOnChainEvent(row.event_json),
        channel: row.channel,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        nextRetryAtMs: row.next_retry_at_ms,
        lastError: row.last_error,
      };
    });
  }

  markOutboxSent(id: number): void {
    this.stmts.markOutboxSent.run(this.now().toISOString(), id);
  }

  rescheduleOutboxItem(
    id: number,
    attempts: number,
    maxAttempts: number,
    nextRetryAtMs: number,
    lastError: string,
  ): "pending" | "dead_letter" {
    const nextStatus = attempts >= maxAttempts ? "dead_letter" : "pending";
    this.stmts.rescheduleOutboxItem.run(
      nextStatus,
      attempts,
      nextRetryAtMs,
      lastError,
      this.now().toISOString(),
      id,
    );
    return nextStatus;
  }

  countPendingOutbox(): number {
    const row = this.stmts.countPendingOutbox.get();
    return z.object({ count: z.number().int() }).parse(row).count;
  }

  getRuleCooldown(ruleId: RuleId, wallet: WalletAddress, eventKind: EventType): number | null {
    const row = this.stmts.getRuleCooldown.get(ruleId, wallet, eventKind);
    if (!row) return null;
    return z.object({ last_triggered_ms: z.number().int() }).parse(row).last_triggered_ms;
  }

  setRuleCooldown(
    ruleId: RuleId,
    wallet: WalletAddress,
    eventKind: EventType,
    triggeredMs: number,
  ): void {
    this.inTransaction(() => {
      if (!this.stmts.getWalletClaimState.get(wallet)) return;
      if (!this.stmts.getRuleManagedByEnv.get(ruleId)) return;
      this.stmts.setRuleCooldown.run(ruleId, wallet, eventKind, Math.trunc(triggeredMs));
    });
  }

  enqueuePendingSignature(params: {
    readonly walletAddress: WalletAddress;
    readonly signature: TxSignature;
    readonly slot: bigint;
    readonly source: "websocket" | "backfill";
    readonly advanceRpcCursor: boolean;
    readonly nextRetryAtMs: number;
  }): boolean {
    return this.inTransaction(() => {
      if (!this.stmts.getWalletClaimState.get(params.walletAddress)) return false;
      this.stmts.upsertPendingSignature.run(
        params.walletAddress,
        params.signature,
        params.slot,
        params.source,
        params.advanceRpcCursor ? 1 : 0,
        0,
        Math.trunc(params.nextRetryAtMs),
        this.now().toISOString(),
      );
      return true;
    });
  }

  listDuePendingSignatures(nowMs: number, limit: number = 25): readonly PendingSignatureItem[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.stmts.listDuePendingSignatures.all(nowMs, bounded);
    return rows.map((raw) => {
      const row = PendingSignatureRowSchema.parse(raw);
      return {
        walletAddress: parseWalletAddress(row.wallet_address),
        signature: parseTxSignature(row.signature),
        slot: row.slot,
        source: row.source,
        advanceRpcCursor: row.advance_rpc_cursor === 1,
        attempts: row.attempts,
        nextRetryAtMs: row.next_retry_at_ms,
      };
    });
  }

  reschedulePendingSignature(
    wallet: WalletAddress,
    signature: TxSignature,
    attempts: number,
    nextRetryAtMs: number,
  ): void {
    this.stmts.reschedulePendingSignature.run(
      attempts,
      Math.trunc(nextRetryAtMs),
      wallet,
      signature,
    );
  }

  deletePendingSignature(wallet: WalletAddress, signature: TxSignature): void {
    this.stmts.deletePendingSignature.run(wallet, signature);
  }

  countPendingSignatures(): number {
    const row = this.stmts.countPendingSignatures.get();
    return z.object({ count: z.number().int() }).parse(row).count;
  }

  pruneHistory(
    options: {
      readonly processedRetentionDays?: number | undefined;
      readonly deliveryRetentionDays?: number | undefined;
      readonly batchSize?: number | undefined;
    } = {},
  ): PruneHistoryResult {
    const processedDays = Math.max(1, options.processedRetentionDays ?? 30);
    const deliveryDays = Math.max(1, options.deliveryRetentionDays ?? 30);
    const batchSize = Math.max(10, Math.min(5_000, options.batchSize ?? 1_000));
    const nowMs = this.now().getTime();
    const processedCutoff = new Date(nowMs - processedDays * 86_400_000).toISOString();
    const deliveryCutoff = new Date(nowMs - deliveryDays * 86_400_000).toISOString();

    return this.inTransaction(() => {
      const processedRes = this.stmts.pruneProcessedBatch.run(processedCutoff, batchSize);
      const deliveryRes = this.stmts.pruneDeliveriesBatch.run(deliveryCutoff, batchSize);
      return {
        processedDeleted: Number(processedRes.changes),
        deliveriesDeleted: Number(deliveryRes.changes),
      };
    });
  }

  checkpoint(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): void {
    if (!this.fileBacked || this.closed) return;
    this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
  }

  optimize(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA optimize;");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fileBacked) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    this.db.exec("PRAGMA optimize;");
    this.db.close();
  }

  private mapWalletRow(raw: unknown): WatchedWallet {
    const row = WalletRowSchema.parse(raw);
    return {
      address: parseWalletAddress(row.address),
      label: row.label,
      enabled: row.enabled === 1,
      lastSignature: row.last_signature !== null ? parseTxSignature(row.last_signature) : null,
      lastSlot: row.last_slot,
      lastRpcSignature:
        row.last_rpc_signature !== null ? parseTxSignature(row.last_rpc_signature) : null,
      lastRpcSlot: row.last_rpc_slot,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRuleRow(raw: unknown): AlertRule {
    const row = RuleRowSchema.parse(raw);
    const eventTypes = z.array(EventTypeSchema).parse(JSON.parse(row.event_types_json));
    const mintAllowlist = z
      .array(z.string())
      .parse(JSON.parse(row.mint_allowlist_json))
      .map(parseMintAddress);
    const mintDenylist = z
      .array(z.string())
      .parse(JSON.parse(row.mint_denylist_json))
      .map(parseMintAddress);

    return {
      id: parseRuleId(row.id),
      walletAddress: row.wallet_address !== null ? parseWalletAddress(row.wallet_address) : null,
      minSolLamports: BigInt(row.min_sol_lamports),
      minUsd: row.min_usd,
      eventTypes,
      mintAllowlist,
      mintDenylist,
      includeFailed: row.include_failed === 1,
      cooldownSeconds: row.cooldown_seconds,
      enabled: row.enabled === 1,
    };
  }
}
