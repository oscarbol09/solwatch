import { describe, expect, it } from "vitest";
import {
  classifyParsedTransaction,
  type SolanaTransactionInput,
} from "../../src/domain/classifier.js";
import {
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
  type TxSignature,
  type WalletAddress,
} from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import type { AlertEnvelope, Notifier } from "../../src/notifiers/types.js";
import { MonitorService, type WalletWatchControl } from "../../src/service/monitorService.js";
import type { SolanaRpcPort } from "../../src/solana/rpcClient.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  makeFailedTx,
  makeIncomingSolTx,
  makeJupiterSwapTx,
  makeToken2022DustTx,
  SIG_FAILED_TX,
  SIG_JUPITER_SWAP,
  SIG_SOL_IN,
  SIG_TOKEN_2022,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const walletB = parseWalletAddress(COUNTERPARTY_WALLET);
const sigIn = parseTxSignature(SIG_SOL_IN);
const sigSwap = parseTxSignature(SIG_JUPITER_SWAP);
const sigFailed = parseTxSignature(SIG_FAILED_TX);
const sigDust = parseTxSignature(SIG_TOKEN_2022);

function makeFakeControl() {
  const watched = new Set<WalletAddress>();
  const unwatched = new Set<WalletAddress>();
  const control: WalletWatchControl = {
    async watchWallet(address) {
      watched.add(address);
    },
    async unwatchWallet(address) {
      unwatched.add(address);
    },
  };
  return { control, watched, unwatched };
}

function makeFakeRpc(map: Map<TxSignature, SolanaTransactionInput>): SolanaRpcPort {
  return {
    async getTransaction(sig) {
      return map.get(sig) ?? null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  };
}

describe("MonitorService", () => {
  it("processes RPC transactions, enforces dedupe & rules, updates cursors, and notifies channels", async () => {
    const store = new SqliteStore(":memory:");
    const sent: AlertEnvelope[] = [];
    const fakeNotifier: Notifier = {
      channel: "memory",
      async send(env) {
        sent.push(env);
      },
    };
    const { control, watched, unwatched } = makeFakeControl();

    const rpcMap = new Map<TxSignature, SolanaTransactionInput>([
      [sigIn, makeIncomingSolTx()],
      [sigSwap, makeJupiterSwapTx()],
      [sigFailed, makeFailedTx()],
      [sigDust, makeToken2022DustTx()],
    ]);

    const service = new MonitorService({
      store,
      rpcPort: makeFakeRpc(rpcMap),
      dispatcher: new AlertDispatcher({
        notifiers: [fakeNotifier],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
      watchControl: control,
      nowMs: () => 1_760_000_000_000,
    });

    service.ensureDefaultGlobalRule({
      minSolLamports: 100_000_000n,
      includeFailed: false,
      cooldownSeconds: 0,
    });

    await service.addWallet(walletA, "Treasury");
    expect(watched.has(walletA)).toBe(true);

    // 1. Incoming 2.5 SOL -> dispatched
    const r1 = await service.processSignature(walletA, sigIn);
    expect(r1.status).toBe("dispatched");
    expect(sent).toHaveLength(1);
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigIn);

    // 2. Duplicate signature -> suppressed
    const rDup = await service.processSignature(walletA, sigIn);
    expect(rDup.status).toBe("deduped");
    expect(sent).toHaveLength(1);

    // 3. Failed tx -> filtered by default rule
    const rFail = await service.processSignature(walletA, sigFailed);
    expect(rFail.status).toBe("filtered");
    if (rFail.status === "filtered") {
      expect(rFail.reason).toBe("failed_tx_suppressed");
    }
    expect(sent).toHaveLength(1);

    // 4. Jupiter swap via direct event ingestion (Helius path) -> dispatched
    const swapEvent = classifyParsedTransaction(makeJupiterSwapTx(), walletA);
    const rSwap = await service.processDirectEvent(swapEvent);
    expect(rSwap.status).toBe("dispatched");
    expect(sent).toHaveLength(2);
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigSwap);

    // 5. Missing transaction on RPC -> skipped cleanly
    const missingSig = parseTxSignature(
      "LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ",
    );
    const rMissing = await service.processSignature(walletA, missingSig);
    expect(rMissing.status).toBe("not_found");

    // 6. Add and remove another wallet dynamically
    await service.addWallet(walletB, "Secondary");
    expect(await service.removeWallet(walletB)).toBe(true);
    expect(unwatched.has(walletB)).toBe(true);
    expect(await service.removeWallet(walletB)).toBe(false);

    expect(service.getMetrics()).toEqual({
      processedTotal: 5,
      dispatchedTotal: 2,
      dedupedTotal: 1,
      filteredTotal: 1,
      notFoundTotal: 1,
    });

    // Ensure idempotent default rule seeding does not overwrite existing custom rules
    store.upsertRule({
      id: parseRuleId("custom-keep"),
      walletAddress: null,
      minSolLamports: 1n,
      eventTypes: ["sol_transfer"],
      mintAllowlist: [],
      mintDenylist: [],
      includeFailed: true,
      cooldownSeconds: 10,
      enabled: true,
    });
    service.ensureDefaultGlobalRule({
      minSolLamports: 5_000_000_000n,
      includeFailed: false,
      cooldownSeconds: 0,
    });
    expect(store.listAllRules().some((r) => r.id === parseRuleId("custom-keep"))).toBe(true);

    store.close();
  });
});
