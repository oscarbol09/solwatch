import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/domain/errors.js";
import { BONK_MINT, USDC_MINT } from "../../src/domain/tokens.js";
import {
  type OnChainEvent,
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
} from "../../src/domain/types.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  SIG_FAILED_TX,
  SIG_JUPITER_SWAP,
  SIG_RAYDIUM_SWAP,
  SIG_SOL_IN,
  SIG_SOL_OUT,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const sigIn = parseTxSignature(SIG_SOL_IN);
const sigOut = parseTxSignature(SIG_SOL_OUT);
const sigSwap = parseTxSignature(SIG_JUPITER_SWAP);
const sigRay = parseTxSignature(SIG_RAYDIUM_SWAP);
const sigFail = parseTxSignature(SIG_FAILED_TX);

describe("SqliteStore", () => {
  const tempDirs: string[] = [];
  const openStores: SqliteStore[] = [];

  const track = (store: SqliteStore): SqliteStore => {
    openStores.push(store);
    return store;
  };

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      store.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables WAL mode on disk, persists wallets/cursors across reopens, and prevents duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "solwatch-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "nested", "solwatch.db");

    const store1 = track(new SqliteStore(dbPath));
    expect(store1.getJournalMode()).toBe("wal");
    expect(store1.getSchemaVersion()).toBe(3);
    expect(store1.ping()).toBe(true);

    const created = store1.createWallet(walletA, "Treasury");
    expect(created.address).toBe(walletA);
    expect(created.label).toBe("Treasury");
    expect(created.enabled).toBe(true);
    expect(created.lastSignature).toBeNull();
    expect(created.lastSlot).toBeNull();
    expect(created.lastRpcSignature).toBeNull();

    expect(() => store1.createWallet(walletA, "Dup")).toThrow(ConflictError);

    store1.updateLastSignature(walletA, sigIn, 310_000_100n, { advanceRpcCursor: true });
    // Older slot or Helius event must never regress cursors or poison lastRpcSignature
    store1.updateLastSignature(walletA, sigOut, 310_000_050n, { advanceRpcCursor: true });
    store1.updateLastSignature(walletA, sigRay, 310_000_200n, { advanceRpcCursor: false });

    const snap = store1.getWallet(walletA);
    expect(snap?.lastSignature).toBe(sigRay);
    expect(snap?.lastSlot).toBe(310_000_200n);
    expect(snap?.lastRpcSignature).toBe(sigIn);
    expect(snap?.lastRpcSlot).toBe(310_000_100n);

    expect(store1.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      true,
    );
    expect(store1.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      false,
    );
    store1.close();

    // Reopen from disk and verify full durability
    const store2 = track(new SqliteStore(dbPath));
    const loaded = store2.getWallet(walletA);
    expect(loaded?.lastSignature).toBe(sigRay);
    expect(loaded?.lastRpcSignature).toBe(sigIn);
    expect(store2.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      false,
    );
    expect(store2.countWallets()).toBe(1);
    expect(store2.listWallets()).toHaveLength(1);

    const paused = store2.updateWallet(walletA, { enabled: false, label: "Vault" });
    expect(paused?.enabled).toBe(false);
    expect(paused?.label).toBe("Vault");
    expect(store2.countWallets(true)).toBe(0);
    expect(store2.countWallets(false)).toBe(1);

    expect(store2.removeWallet(walletA)).toBe(true);
    expect(store2.removeWallet(walletA)).toBe(false);
    expect(store2.listWallets()).toHaveLength(0);
    expect(store2.tryMarkSignatureProcessed(walletA, sigOut, 310_000_250n, "sol_transfer")).toBe(
      false,
    );
    store2.close();
  });

  it("migrates legacy v1 databases (TEXT slots) cleanly to schema v2 inside a transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "solwatch-v1-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "legacy.db");

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE watched_wallets (
        address TEXT PRIMARY KEY,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_signature TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY,
        wallet_address TEXT,
        min_sol_lamports TEXT NOT NULL,
        event_types_json TEXT NOT NULL,
        mint_allowlist_json TEXT NOT NULL,
        mint_denylist_json TEXT NOT NULL,
        include_failed INTEGER NOT NULL DEFAULT 0,
        cooldown_seconds INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE processed_signatures (
        wallet_address TEXT NOT NULL,
        signature TEXT NOT NULL,
        slot TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (wallet_address, signature)
      );
      CREATE TABLE alert_deliveries (
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
      INSERT INTO watched_wallets VALUES ('${WATCHED_WALLET_A}', 'Legacy', 1, '${SIG_SOL_IN}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO processed_signatures VALUES ('${WATCHED_WALLET_A}', '${SIG_SOL_IN}', '310000100', 'sol_transfer', '2026-01-01T00:00:00.000Z');
    `);
    legacyDb.close();

    const migrated = track(new SqliteStore(dbPath));
    expect(migrated.getSchemaVersion()).toBe(3);
    expect(migrated.getWallet(walletA)?.lastSignature).toBe(SIG_SOL_IN);
    expect(migrated.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      false,
    );
    expect(
      migrated.claimSignatureAndAdvanceCursor({
        wallet: walletA,
        signature: sigOut,
        slot: 310_000_200n,
        eventKind: "sol_transfer",
        advanceRpcCursor: true,
      }),
    ).toEqual({
      status: "claimed",
      walletLabel: "Legacy",
      walletEnabled: true,
    });
  });

  it("stores and restores BigInt lamports > MAX_SAFE_INTEGER, rules, and deletes cleanly", () => {
    const store = track(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Whale");

    const hugeLamports = 18_446_744_073_709_551_615n;
    const ruleId = parseRuleId("whale-rule");
    store.upsertRule(
      {
        id: ruleId,
        walletAddress: walletA,
        minSolLamports: hugeLamports,
        minUsd: 125.5,
        eventTypes: ["sol_transfer", "dex_swap"],
        mintAllowlist: [USDC_MINT],
        mintDenylist: [BONK_MINT],
        includeFailed: true,
        cooldownSeconds: 45,
        enabled: true,
      },
      { managedByEnv: true },
    );

    expect(store.isRuleManagedByEnv(ruleId)).toBe(true);
    expect(store.getRule(ruleId)?.minUsd).toBe(125.5);
    const rules = store.listRulesForWallet(walletA);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.minSolLamports).toBe(hugeLamports);
    expect(rules[0]?.minUsd).toBe(125.5);
    expect(rules[0]?.mintAllowlist).toEqual([USDC_MINT]);
    expect(rules[0]?.mintDenylist).toEqual([BONK_MINT]);
    expect(rules[0]?.includeFailed).toBe(true);
    expect(rules[0]?.cooldownSeconds).toBe(45);

    store.upsertTokenMetadata({
      mint: USDC_MINT,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      usdPrice: 1,
      priceUpdatedAtMs: 1_760_000_000_000,
      updatedAtMs: 1_760_000_000_000,
    });
    expect(store.getTokenMetadata(USDC_MINT)?.usdPrice).toBe(1);

    expect(store.deleteRule(ruleId)).toBe(true);
    expect(store.getRule(ruleId)).toBeNull();
    expect(store.deleteRule(ruleId)).toBe(false);
    expect(store.isRuleManagedByEnv(ruleId)).toBe(false);
  });

  it("supports outbox retries, pending signatures, rule cooldowns, keyset pagination, and retention pruning", () => {
    let nowMs = 1_760_000_000_000;
    const store = track(new SqliteStore(":memory:", () => new Date(nowMs)));
    store.createWallet(walletA, "Main");

    const event: OnChainEvent = {
      kind: "sol_transfer",
      signature: sigIn,
      slot: 310_000_100n,
      timestampSec: 1_760_000_000,
      wallet: walletA,
      direction: "in",
      counterparty: COUNTERPARTY_WALLET,
      lamports: 2_500_000_000n,
      feeLamports: 5_000n,
      success: true,
    };

    store.enqueueOutboxItems([
      {
        deliveryId: "del-1",
        walletAddress: walletA,
        walletLabel: "Main",
        signature: sigIn,
        event,
        channel: "discord",
        nextRetryAtMs: nowMs + 10_000,
        lastError: "HTTP 503",
        maxAttempts: 2,
      },
    ]);
    expect(store.countPendingOutbox()).toBe(1);
    expect(store.listDueOutboxItems(nowMs + 5_000)).toHaveLength(0);
    const due = store.listDueOutboxItems(nowMs + 10_000);
    expect(due).toHaveLength(1);
    const firstDue = due[0];
    if (!firstDue) throw new Error("Expected due outbox item");
    expect(firstDue.event).toEqual(event);

    expect(store.rescheduleOutboxItem(firstDue.id, 1, 2, nowMs + 20_000, "still failing")).toBe(
      "pending",
    );
    expect(store.rescheduleOutboxItem(firstDue.id, 2, 2, nowMs + 40_000, "permanent error")).toBe(
      "dead_letter",
    );
    expect(store.countPendingOutbox()).toBe(0);

    // Pending signatures
    expect(
      store.enqueuePendingSignature({
        walletAddress: walletA,
        signature: sigFail,
        slot: 310_000_500n,
        source: "websocket",
        advanceRpcCursor: true,
        nextRetryAtMs: nowMs + 1_000,
      }),
    ).toBe(true);
    expect(store.countPendingSignatures()).toBe(1);
    expect(store.listDuePendingSignatures(nowMs + 1_000)).toHaveLength(1);
    store.deletePendingSignature(walletA, sigFail);
    expect(store.countPendingSignatures()).toBe(0);

    // Persisted rule cooldowns
    const ruleId = parseRuleId("r1");
    store.upsertRule({
      id: ruleId,
      walletAddress: null,
      minSolLamports: 0n,
      eventTypes: ["sol_transfer"],
      mintAllowlist: [],
      mintDenylist: [],
      includeFailed: false,
      cooldownSeconds: 60,
      enabled: true,
    });
    store.setRuleCooldown(ruleId, walletA, "sol_transfer", nowMs);
    expect(store.getRuleCooldown(ruleId, walletA, "sol_transfer")).toBe(nowMs);

    // Multi-channel deliveries + keyset pagination + pruning
    store.recordDeliveriesBatch([
      {
        walletAddress: walletA,
        signature: sigIn,
        eventKind: "sol_transfer",
        summary: "Old alert",
        channel: "telegram",
        status: "sent",
      },
      {
        walletAddress: walletA,
        signature: sigSwap,
        eventKind: "dex_swap",
        summary: "Failed swap",
        channel: "discord",
        status: "failed",
        errorMessage: "HTTP 429",
      },
    ]);

    nowMs += 40 * 86_400_000;
    store.recordDelivery({
      walletAddress: walletA,
      signature: sigOut,
      eventKind: "sol_transfer",
      summary: "Fresh alert",
      channel: "telegram",
      status: "sent",
    });

    const page1 = store.listRecentAlerts(2, walletA);
    expect(page1).toHaveLength(2);
    const cursorRow = page1[1];
    if (!cursorRow) throw new Error("Expected second delivery row");
    const page2 = store.listRecentAlerts(2, walletA, { beforeId: cursorRow.id });
    expect(page2).toHaveLength(1);
    expect(page2[0]?.summary).toBe("Old alert");
    expect(
      store.listRecentAlerts(10, walletA, { status: "failed", channel: "discord" }),
    ).toHaveLength(1);

    const pruned = store.pruneHistory({ processedRetentionDays: 30, deliveryRetentionDays: 30 });
    expect(pruned.deliveriesDeleted).toBe(2);
    expect(store.listRecentAlerts(10)).toHaveLength(1);

    // Nested SAVEPOINT rollback leaves outer transaction intact; partial/missing updateWallet & unwatched outbox guarded cleanly
    expect(
      store.updateWallet(parseWalletAddress(COUNTERPARTY_WALLET), { label: "Nope" }),
    ).toBeNull();
    expect(store.updateWallet(walletA, { label: "MainRenamed" })?.label).toBe("MainRenamed");

    store.inTransaction(() => {
      store.recordDelivery({
        walletAddress: walletA,
        signature: sigSwap,
        eventKind: "dex_swap",
        summary: "Outer kept",
        channel: "console",
        status: "sent",
      });
      expect(() =>
        store.inTransaction(() => {
          store.recordDelivery({
            walletAddress: walletA,
            signature: sigFail,
            eventKind: "program_interaction",
            summary: "Inner rolled back",
            channel: "console",
            status: "failed",
          });
          throw new Error("rollback inner");
        }),
      ).toThrow("rollback inner");
    });

    const summariesAfterTx = store.listRecentAlerts(10).map((r) => r.summary);
    expect(summariesAfterTx).toContain("Outer kept");
    expect(summariesAfterTx).not.toContain("Inner rolled back");

    expect(
      store.enqueuePendingSignature({
        walletAddress: parseWalletAddress(COUNTERPARTY_WALLET),
        signature: sigFail,
        slot: 100n,
        source: "websocket",
        advanceRpcCursor: true,
        nextRetryAtMs: nowMs,
      }),
    ).toBe(false);

    store.enqueueOutboxItems([
      {
        deliveryId: "ignored-unwatched",
        walletAddress: parseWalletAddress(COUNTERPARTY_WALLET),
        walletLabel: null,
        signature: sigFail,
        event,
        channel: "webhook",
        nextRetryAtMs: nowMs,
        lastError: "err",
      },
    ]);
    expect(store.countPendingOutbox()).toBe(0);
  });
});
