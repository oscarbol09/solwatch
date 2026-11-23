import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ConflictError } from "../domain/errors.js";
import {
  type AlertRule,
  type EventType,
  parseMintAddress,
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
  type TxSignature,
  type WalletAddress,
  type WatchedWallet,
} from "../domain/types.js";

const EventTypeSchema = z.enum(["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"]);

const WalletRowSchema = z.object({
  address: z.string(),
  label: z.string().nullable(),
  enabled: z.number().int(),
  last_signature: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const RuleRowSchema = z.object({
  id: z.string(),
  wallet_address: z.string().nullable(),
  min_sol_lamports: z.string(),
  event_types_json: z.string(),
  mint_allowlist_json: z.string(),
  mint_denylist_json: z.string(),
  include_failed: z.number().int(),
  cooldown_seconds: z.number().int(),
  enabled: z.number().int(),
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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS watched_wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  wallet_address TEXT REFERENCES watched_wallets(address) ON DELETE CASCADE,
  min_sol_lamports TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  mint_allowlist_json TEXT NOT NULL,
  mint_denylist_json TEXT NOT NULL,
  include_failed INTEGER NOT NULL DEFAULT 0,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS processed_signatures (
  wallet_address TEXT NOT NULL REFERENCES watched_wallets(address) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  slot TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (wallet_address, signature)
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  delivered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_wallet_time
  ON alert_deliveries (wallet_address, id DESC);
`;

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(dbPath: string, now: () => Date = () => new Date()) {
    this.now = now;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });

    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    this.db.exec(SCHEMA_SQL);
  }

  getJournalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get();
    const parsed = z.object({ journal_mode: z.string() }).parse(row);
    return parsed.journal_mode;
  }

  createWallet(address: WalletAddress, label: string | null = null): WatchedWallet {
    const timestamp = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO watched_wallets (address, label, enabled, last_signature, created_at, updated_at)
         VALUES (?, ?, 1, NULL, ?, ?)`,
      )
      .run(address, label, timestamp, timestamp);

    if (Number(result.changes) === 0) {
      throw new ConflictError(`Wallet ${address} is already watched`, { address });
    }
    const created = this.getWallet(address);
    if (!created) {
      throw new Error(`Failed to reload wallet ${address} after insert`);
    }
    return created;
  }

  upsertWallet(
    address: WalletAddress,
    label: string | null = null,
    enabled: boolean = true,
  ): WatchedWallet {
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO watched_wallets (address, label, enabled, last_signature, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           label = COALESCE(excluded.label, watched_wallets.label),
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(address, label, enabled ? 1 : 0, timestamp, timestamp);

    const saved = this.getWallet(address);
    if (!saved) {
      throw new Error(`Failed to reload wallet ${address} after upsert`);
    }
    return saved;
  }

  removeWallet(address: WalletAddress): boolean {
    const result = this.db.prepare("DELETE FROM watched_wallets WHERE address = ?").run(address);
    return Number(result.changes) > 0;
  }

  getWallet(address: WalletAddress): WatchedWallet | null {
    const row = this.db.prepare("SELECT * FROM watched_wallets WHERE address = ?").get(address);
    return row ? this.mapWalletRow(row) : null;
  }

  listWallets(enabledOnly: boolean = false): readonly WatchedWallet[] {
    const sql = enabledOnly
      ? "SELECT * FROM watched_wallets WHERE enabled = 1 ORDER BY created_at ASC"
      : "SELECT * FROM watched_wallets ORDER BY created_at ASC";
    const rows = this.db.prepare(sql).all();
    return rows.map((row) => this.mapWalletRow(row));
  }

  updateLastSignature(address: WalletAddress, signature: TxSignature): void {
    const timestamp = this.now().toISOString();
    this.db
      .prepare("UPDATE watched_wallets SET last_signature = ?, updated_at = ? WHERE address = ?")
      .run(signature, timestamp, address);
  }

  upsertRule(rule: AlertRule): void {
    this.db
      .prepare(
        `INSERT INTO alert_rules (
           id, wallet_address, min_sol_lamports, event_types_json,
           mint_allowlist_json, mint_denylist_json, include_failed, cooldown_seconds, enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           wallet_address = excluded.wallet_address,
           min_sol_lamports = excluded.min_sol_lamports,
           event_types_json = excluded.event_types_json,
           mint_allowlist_json = excluded.mint_allowlist_json,
           mint_denylist_json = excluded.mint_denylist_json,
           include_failed = excluded.include_failed,
           cooldown_seconds = excluded.cooldown_seconds,
           enabled = excluded.enabled`,
      )
      .run(
        rule.id,
        rule.walletAddress,
        rule.minSolLamports.toString(),
        JSON.stringify(rule.eventTypes),
        JSON.stringify(rule.mintAllowlist),
        JSON.stringify(rule.mintDenylist),
        rule.includeFailed ? 1 : 0,
        rule.cooldownSeconds,
        rule.enabled ? 1 : 0,
      );
  }

  listRulesForWallet(walletAddress: WalletAddress | null): readonly AlertRule[] {
    const rows =
      walletAddress === null
        ? this.db.prepare("SELECT * FROM alert_rules WHERE wallet_address IS NULL").all()
        : this.db
            .prepare("SELECT * FROM alert_rules WHERE wallet_address = ? OR wallet_address IS NULL")
            .all(walletAddress);
    return rows.map((row) => this.mapRuleRow(row));
  }

  listAllRules(): readonly AlertRule[] {
    const rows = this.db.prepare("SELECT * FROM alert_rules").all();
    return rows.map((row) => this.mapRuleRow(row));
  }

  tryMarkSignatureProcessed(
    wallet: WalletAddress,
    signature: TxSignature,
    slot: bigint,
    eventKind: EventType,
  ): boolean {
    const timestamp = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_signatures (wallet_address, signature, slot, event_kind, processed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(wallet, signature, slot.toString(), eventKind, timestamp);
    return Number(result.changes) === 1;
  }

  recordDelivery(entry: NewDeliveryRecord): void {
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO alert_deliveries (
           wallet_address, signature, event_kind, summary, channel, status, error_message, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  listRecentAlerts(
    limit: number = 25,
    walletAddress?: WalletAddress,
  ): readonly AlertDeliveryRecord[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = walletAddress
      ? this.db
          .prepare(
            "SELECT * FROM alert_deliveries WHERE wallet_address = ? ORDER BY id DESC LIMIT ?",
          )
          .all(walletAddress, bounded)
      : this.db.prepare("SELECT * FROM alert_deliveries ORDER BY id DESC LIMIT ?").all(bounded);

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

  close(): void {
    this.db.close();
  }

  private mapWalletRow(raw: unknown): WatchedWallet {
    const row = WalletRowSchema.parse(raw);
    return {
      address: parseWalletAddress(row.address),
      label: row.label,
      enabled: row.enabled === 1,
      lastSignature: row.last_signature !== null ? parseTxSignature(row.last_signature) : null,
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
      eventTypes,
      mintAllowlist,
      mintDenylist,
      includeFailed: row.include_failed === 1,
      cooldownSeconds: row.cooldown_seconds,
      enabled: row.enabled === 1,
    };
  }
}
