import { afterEach, describe, expect, it } from "vitest";
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
  makeProgramOnlyTx,
  makeToken2022DustTx,
  SIG_FAILED_TX,
  SIG_JUPITER_SWAP,
  SIG_PROGRAM_ONLY,
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
const sigProgram = parseTxSignature(SIG_PROGRAM_ONLY);

function makeFakeControl() {
  const watched = new Set<WalletAddress>();
  const unwatched = new Set<WalletAddress>();
  const refreshedAtas: WalletAddress[] = [];
  const control: WalletWatchControl = {
    async watchWallet(address) {
      watched.add(address);
    },
    async unwatchWallet(address) {
      unwatched.add(address);
    },
    async refreshWalletTokenAccounts(address) {
      refreshedAtas.push(address);
    },
  };
  return { control, watched, unwatched, refreshedAtas };
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
  const openStores: SqliteStore[] = [];
  const trackStore = (store: SqliteStore): SqliteStore => {
    openStores.push(store);
    return store;
  };

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      store.close();
    }
  });

  it("processes RPC transactions, enforces dedupe & rules, preserves monotonic cursors, and notifies channels", async () => {
    const store = trackStore(new SqliteStore(":memory:"));
    const sent: AlertEnvelope[] = [];
    const fakeNotifier: Notifier = {
      channel: "memory",
      async send(env) {
        sent.push(env);
      },
    };
    const { control, watched, unwatched } = makeFakeControl();

    const rpcMap = new Map<TxSignature, SolanaTransactionInput>([
      [sigIn, makeIncomingSolTx()], // slot 310_000_100n
      [sigSwap, makeJupiterSwapTx()], // slot 310_000_400n
      [sigFailed, makeFailedTx()], // slot 310_000_500n
      [sigDust, makeToken2022DustTx()], // slot 310_000_350n
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

    // 1. Incoming 2.5 SOL (slot 100) -> dispatched
    const r1 = await service.processSignature(walletA, sigIn);
    expect(r1.status).toBe("dispatched");
    expect(sent).toHaveLength(1);
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigIn);
    expect(store.getWallet(walletA)?.lastRpcSignature).toBe(sigIn);

    // 2. Duplicate signature -> suppressed
    const rDup = await service.processSignature(walletA, sigIn);
    expect(rDup.status).toBe("deduped");
    expect(sent).toHaveLength(1);

    // 3. Failed tx (slot 500) -> filtered by default rule, advances RPC cursor to slot 500
    const rFail = await service.processSignature(walletA, sigFailed);
    expect(rFail.status).toBe("filtered");
    if (rFail.status === "filtered") {
      expect(rFail.reason).toBe("failed_tx_suppressed");
    }
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigFailed);
    expect(store.getWallet(walletA)?.lastRpcSignature).toBe(sigFailed);

    // 4. Jupiter swap via direct event (slot 400 < 500, advanceRpcCursor: false) -> dispatched WITHOUT regressing cursors
    const swapEvent = classifyParsedTransaction(makeJupiterSwapTx(), walletA);
    const rSwap = await service.processDirectEvent(swapEvent);
    expect(rSwap.status).toBe("dispatched");
    expect(sent).toHaveLength(2);
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigFailed);
    expect(store.getWallet(walletA)?.lastRpcSignature).toBe(sigFailed);

    // Newer direct Helius event (slot 600) updates lastSignature without poisoning lastRpcSignature
    const newerDirect = classifyParsedTransaction(makeProgramOnlyTx(), walletA);
    await service.processDirectEvent(newerDirect);
    expect(store.getWallet(walletA)?.lastSignature).toBe(sigProgram);
    expect(store.getWallet(walletA)?.lastRpcSignature).toBe(sigFailed);

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
      processedTotal: 6,
      dispatchedTotal: 3,
      deliverySucceededTotal: 3,
      deliveryFailedTotal: 0,
      dedupedTotal: 1,
      filteredTotal: 1,
      notFoundTotal: 1,
      directQueueDepth: 0,
      directQueueDroppedTotal: 0,
      outboxPendingCount: 0,
      pendingSignaturesCount: 0,
    });

    // Env-managed rule updates on restart unless edited by user via service.upsertRule()
    service.ensureDefaultGlobalRule({
      minSolLamports: 250_000_000n,
      includeFailed: false,
      cooldownSeconds: 0,
    });
    const syncedGlobal = store.listAllRules().find((r) => r.id === parseRuleId("global-default"));
    expect(syncedGlobal?.minSolLamports).toBe(250_000_000n);

    // Custom non-env rule is preserved across env syncs
    service.upsertRule({
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
  });

  it("handles concurrent removeWallet vs processSignature and Helius batches without SQLITE_CONSTRAINT_FOREIGNKEY", async () => {
    const store = trackStore(new SqliteStore(":memory:"));
    let notifyGetTxStarted!: () => void;
    let releaseGetTx!: () => void;

    const slowRpc: SolanaRpcPort = {
      async getTransaction() {
        notifyGetTxStarted();
        await new Promise<void>((resolve) => {
          releaseGetTx = resolve;
        });
        return makeIncomingSolTx();
      },
      async getSignaturesForAddress() {
        return [];
      },
    };

    const service = new MonitorService({
      store,
      rpcPort: slowRpc,
      dispatcher: new AlertDispatcher({
        notifiers: [],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
    });
    service.ensureDefaultGlobalRule({
      minSolLamports: 0n,
      includeFailed: false,
      cooldownSeconds: 0,
    });

    await service.addWallet(walletA, "Race");

    const started = new Promise<void>((resolve) => {
      notifyGetTxStarted = resolve;
    });
    const inFlightSig = service.processSignature(walletA, sigIn);
    await started;

    // Delete wallet concurrently while RPC was in flight AND enqueue a direct batch referencing deleted wallet
    expect(await service.removeWallet(walletA)).toBe(true);
    releaseGetTx();

    const sigOutcome = await inFlightSig;
    expect(sigOutcome).toEqual({ status: "filtered", reason: "wallet_unwatched" });

    const directOutcome = await service.processDirectEvent(
      classifyParsedTransaction(makeJupiterSwapTx(), walletA),
    );
    expect(directOutcome).toEqual({ status: "filtered", reason: "wallet_unwatched" });
  });

  it("short-circuits failed txs before RPC, retries not_found via pending_signatures, and recovers failed alerts via outbox + persisted cooldowns", async () => {
    let nowMs = 1_760_000_000_000;
    const store = trackStore(new SqliteStore(":memory:", () => new Date(nowMs)));

    let failNotify = true;
    const delivered: string[] = [];
    const flakyNotifier: Notifier = {
      channel: "memory",
      async send(env) {
        if (failNotify) {
          throw new Error("Upstream 503");
        }
        delivered.push(env.event.signature);
      },
    };

    let rpcCalls = 0;
    let returnTx = false;
    const rpc: SolanaRpcPort = {
      async getTransaction(sig) {
        rpcCalls += 1;
        return returnTx && sig === sigIn ? makeIncomingSolTx() : null;
      },
      async getSignaturesForAddress() {
        return [];
      },
    };

    const service = new MonitorService({
      store,
      rpcPort: rpc,
      dispatcher: new AlertDispatcher({
        notifiers: [flakyNotifier],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
      nowMs: () => nowMs,
    });
    service.ensureDefaultGlobalRule({
      minSolLamports: 100_000_000n,
      includeFailed: false,
      cooldownSeconds: 60,
    });
    await service.addWallet(walletA, "Main");

    // 1. Pre-RPC failed tx short-circuit: 0 RPC calls!
    const failedOutcome = await service.processSignature(walletA, sigFailed, undefined, {
      slot: 310_000_500n,
      err: { InstructionError: [0, "Custom"] },
      advanceRpcCursor: true,
    });
    expect(failedOutcome).toEqual({ status: "filtered", reason: "failed_tx_suppressed" });
    expect(rpcCalls).toBe(0);

    // 2. not_found on initial fetch gets queued in pending_signatures and succeeds when RPC catches up
    const notFoundOutcome = await service.processSignature(walletA, sigIn, undefined, {
      slot: 310_000_600n,
      err: null,
      advanceRpcCursor: true,
    });
    expect(notFoundOutcome).toEqual({ status: "not_found" });
    expect(store.countPendingSignatures()).toBe(1);

    // RPC indexes tx, retry runs while notifier is down -> enqueues outbox item, dispatchedTotal stays 0 & cooldown NOT burned
    returnTx = true;
    nowMs += 2_000;
    expect(await service.processPendingSignatures()).toBe(1);
    expect(store.countPendingSignatures()).toBe(0);
    expect(service.getMetrics().dispatchedTotal).toBe(0);
    expect(service.getMetrics().deliveryFailedTotal).toBe(1);
    expect(store.countPendingOutbox()).toBe(1);

    // Cooldown must NOT have blocked a fresh alert because all channels failed earlier
    const directSol = {
      ...classifyParsedTransaction(makeIncomingSolTx(), walletA),
      signature: sigSwap,
    };
    failNotify = false;
    const okSecond = await service.processDirectEvent(directSol);
    expect(okSecond.status).toBe("dispatched");
    expect(delivered).toEqual([sigSwap]);

    // Outbox retry delivers the earlier failed sigIn alert cleanly
    nowMs += 20_000;
    expect(await service.processOutbox()).toBe(1);
    expect(store.countPendingOutbox()).toBe(0);
    expect(delivered).toEqual([sigSwap, sigIn]);

    // Persisted cooldown survives MonitorService restart inside the 60s window
    const restartedService = new MonitorService({
      store,
      rpcPort: rpc,
      dispatcher: new AlertDispatcher({
        notifiers: [flakyNotifier],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
      nowMs: () => nowMs + 10_000,
    });
    const thirdSol = {
      ...classifyParsedTransaction(makeIncomingSolTx(), walletA),
      signature: sigProgram,
    };
    const cooldownFiltered = await restartedService.processDirectEvent(thirdSol);
    expect(cooldownFiltered).toEqual({ status: "filtered", reason: "cooldown_active" });
  });

  it("supports wallet pause/resume, deleteRule, ATA refresh triggers, outbox backoff/cap, direct queue overflow, and background workers", async () => {
    let nowMs = 1_760_000_000_000;
    const store = trackStore(new SqliteStore(":memory:", () => new Date(nowMs)));
    const { control, watched, unwatched, refreshedAtas } = makeFakeControl();

    let returnNull = true;
    const txWithAta = {
      ...makeIncomingSolTx(),
      programIds: [
        "11111111111111111111111111111111",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      ],
    };
    const rpc: SolanaRpcPort = {
      async getTransaction(sig) {
        if (returnNull) return null;
        return sig === sigIn ? txWithAta : makeIncomingSolTx();
      },
      async getSignaturesForAddress() {
        return [];
      },
    };

    const failingNotifier: Notifier = {
      channel: "webhook",
      async send() {
        throw "string failure";
      },
    };

    const service = new MonitorService({
      store,
      rpcPort: rpc,
      dispatcher: new AlertDispatcher({
        notifiers: [failingNotifier],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
      watchControl: control,
      nowMs: () => nowMs,
      maxDirectQueueSize: 10,
      outboxIntervalMs: 5_000,
      pendingRetryIntervalMs: 5_000,
      maintenanceIntervalMs: 60_000,
    });
    service.ensureDefaultGlobalRule({
      minSolLamports: 0n,
      includeFailed: false,
      cooldownSeconds: 0,
    });

    // updateWallet on missing returns null
    expect(await service.updateWallet(walletA, { enabled: false })).toBeNull();

    await service.addWallet(walletA, "Ops");
    expect(service.getEnabledWalletSet().has(walletA)).toBe(true);

    // Pause -> triggers unwatchWallet and suppresses processing
    const paused = await service.updateWallet(walletA, { enabled: false, label: "PausedOps" });
    expect(paused?.enabled).toBe(false);
    expect(unwatched.has(walletA)).toBe(true);
    expect(await service.processSignature(walletA, sigIn)).toEqual({
      status: "filtered",
      reason: "wallet_paused",
    });

    // Direct event on paused wallet also marks filtered wallet_paused
    expect(
      await service.processDirectEvent(classifyParsedTransaction(makeIncomingSolTx(), walletA)),
    ).toEqual({
      status: "filtered",
      reason: "wallet_paused",
    });

    // Resume -> triggers watchWallet cleanly
    watched.clear();
    const resumed = await service.updateWallet(walletA, { enabled: true });
    expect(resumed?.enabled).toBe(true);
    expect(watched.has(walletA)).toBe(true);

    // pending_signatures exhausts 5 retries when RPC keeps returning null
    expect(
      await service.processSignature(walletA, sigSwap, undefined, {
        slot: 310_000_700n,
        err: null,
        advanceRpcCursor: true,
      }),
    ).toEqual({ status: "not_found" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      nowMs += 60_000;
      await service.processPendingSignatures();
    }
    expect(store.countPendingSignatures()).toBe(0);

    // processSignature invoking ASSOCIATED_TOKEN_PROGRAM triggers refreshWalletTokenAccounts
    returnNull = false;
    await service.processSignature(walletA, sigIn, undefined, {
      slot: 310_000_800n,
      err: null,
      advanceRpcCursor: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(refreshedAtas).toContain(walletA);

    // processOutbox reschedules on persistent non-Error failure
    expect(store.countPendingOutbox()).toBe(1);
    nowMs += 20_000;
    expect(await service.processOutbox()).toBe(1);
    expect(store.countPendingOutbox()).toBe(1);

    // Enqueue overflow on directQueue drops excess cleanly and drain completes
    const spamEvents = Array.from({ length: 15 }, (_, idx) => ({
      ...classifyParsedTransaction(makeIncomingSolTx(), walletA),
      signature: parseTxSignature(idx % 2 === 0 ? SIG_JUPITER_SWAP : SIG_PROGRAM_ONLY),
    }));
    const enq = service.enqueueDirectEvents(spamEvents);
    expect(enq.queued).toBe(10);
    expect(enq.dropped).toBe(5);
    await service.drain();

    // Background workers & deleteRule
    service.startBackgroundWorkers();
    service.runMaintenance();
    service.stopBackgroundWorkers();
    expect(service.deleteRule(parseRuleId("nonexistent-rule"))).toBe(false);
  });
});
