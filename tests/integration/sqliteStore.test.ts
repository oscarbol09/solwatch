import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/domain/errors.js";
import { BONK_MINT, USDC_MINT } from "../../src/domain/tokens.js";
import { parseRuleId, parseTxSignature, parseWalletAddress } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { SIG_JUPITER_SWAP, SIG_SOL_IN, WATCHED_WALLET_A } from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const sigIn = parseTxSignature(SIG_SOL_IN);
const sigSwap = parseTxSignature(SIG_JUPITER_SWAP);

describe("SqliteStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables WAL mode on disk, persists wallets/cursors across reopens, and prevents duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "solwatch-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "nested", "solwatch.db");

    const store1 = new SqliteStore(dbPath);
    expect(store1.getJournalMode()).toBe("wal");

    const created = store1.createWallet(walletA, "Treasury");
    expect(created.address).toBe(walletA);
    expect(created.label).toBe("Treasury");
    expect(created.enabled).toBe(true);
    expect(created.lastSignature).toBeNull();

    expect(() => store1.createWallet(walletA, "Dup")).toThrow(ConflictError);

    store1.updateLastSignature(walletA, sigIn);
    expect(store1.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      true,
    );
    expect(store1.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      false,
    );
    store1.close();

    // Reopen from disk and verify full durability
    const store2 = new SqliteStore(dbPath);
    const loaded = store2.getWallet(walletA);
    expect(loaded?.lastSignature).toBe(sigIn);
    expect(store2.tryMarkSignatureProcessed(walletA, sigIn, 310_000_100n, "sol_transfer")).toBe(
      false,
    );
    expect(store2.listWallets()).toHaveLength(1);
    expect(store2.removeWallet(walletA)).toBe(true);
    expect(store2.removeWallet(walletA)).toBe(false);
    expect(store2.listWallets()).toHaveLength(0);
    store2.close();
  });

  it("stores and restores BigInt lamports > MAX_SAFE_INTEGER and rule mint filters accurately", () => {
    const store = new SqliteStore(":memory:");
    store.upsertWallet(walletA, "Whale");

    const hugeLamports = 18_446_744_073_709_551_615n;
    store.upsertRule({
      id: parseRuleId("whale-rule"),
      walletAddress: walletA,
      minSolLamports: hugeLamports,
      eventTypes: ["sol_transfer", "dex_swap"],
      mintAllowlist: [USDC_MINT],
      mintDenylist: [BONK_MINT],
      includeFailed: true,
      cooldownSeconds: 45,
      enabled: true,
    });

    const rules = store.listRulesForWallet(walletA);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.minSolLamports).toBe(hugeLamports);
    expect(rules[0]?.mintAllowlist).toEqual([USDC_MINT]);
    expect(rules[0]?.mintDenylist).toEqual([BONK_MINT]);
    expect(rules[0]?.includeFailed).toBe(true);
    expect(rules[0]?.cooldownSeconds).toBe(45);
    store.close();
  });

  it("records multi-channel alert deliveries and returns newest alerts first", () => {
    const store = new SqliteStore(":memory:");
    store.upsertWallet(walletA, "Main");

    store.recordDelivery({
      walletAddress: walletA,
      signature: sigIn,
      eventKind: "sol_transfer",
      summary: "Received 2.5 SOL",
      channel: "telegram",
      status: "sent",
    });
    store.recordDelivery({
      walletAddress: walletA,
      signature: sigSwap,
      eventKind: "dex_swap",
      summary: "Swapped 1.5 SOL -> 240 USDC",
      channel: "discord",
      status: "failed",
      errorMessage: "HTTP 429 rate limited",
    });

    const all = store.listRecentAlerts(10);
    expect(all).toHaveLength(2);
    expect(all[0]?.signature).toBe(sigSwap);
    expect(all[0]?.status).toBe("failed");
    expect(all[0]?.errorMessage).toBe("HTTP 429 rate limited");
    expect(all[1]?.signature).toBe(sigIn);
    expect(all[1]?.status).toBe("sent");
    expect(all[1]?.errorMessage).toBeNull();

    expect(store.listRecentAlerts(1, walletA)).toHaveLength(1);
    store.close();
  });
});
