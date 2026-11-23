import {
  SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED,
  SolanaError,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTxSignature,
  parseWalletAddress,
  type TxSignature,
  type WalletAddress,
} from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import type { SignatureSummary, SolanaRpcPort } from "../../src/solana/rpcClient.js";
import {
  type LogNotificationItem,
  type LogsSubscriptionPort,
  SolanaWatcher,
} from "../../src/solana/watcher.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  SIG_JUPITER_SWAP,
  SIG_RAYDIUM_SWAP,
  SIG_SOL_IN,
  SIG_SOL_OUT,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const walletB = parseWalletAddress(COUNTERPARTY_WALLET);
const sig1 = parseTxSignature(SIG_SOL_IN);
const sig2 = parseTxSignature(SIG_SOL_OUT);
const sig3 = parseTxSignature(SIG_JUPITER_SWAP);
const sig4 = parseTxSignature(SIG_RAYDIUM_SWAP);

function createFakeSubscriptionPort() {
  const streams = new Map<
    string,
    Array<(items: LogNotificationItem[], failAfter?: boolean) => void>
  >();
  let connectCount = 0;
  const activeControllers: AbortController[] = [];

  class ScriptedQueue {
    private readonly items: LogNotificationItem[] = [];
    private errorToThrow: unknown = null;
    private closed = false;
    private waiter: (() => void) | null = null;

    push(item: LogNotificationItem): void {
      this.items.push(item);
      this.wake();
    }

    fail(err: unknown): void {
      this.errorToThrow = err;
      this.wake();
    }

    close(): void {
      this.closed = true;
      this.wake();
    }

    private wake(): void {
      const w = this.waiter;
      this.waiter = null;
      w?.();
    }

    async *iterate(signal: AbortSignal): AsyncIterable<LogNotificationItem> {
      while (!signal.aborted) {
        if (this.items.length > 0) {
          const next = this.items.shift();
          if (next) yield next;
          continue;
        }
        if (this.errorToThrow !== null) {
          throw this.errorToThrow;
        }
        if (this.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    }
  }

  const queuesByCall: ScriptedQueue[] = [];
  const queuesByWallet = new Map<WalletAddress, ScriptedQueue[]>();

  const port: LogsSubscriptionPort = {
    async subscribeLogs(wallet, _commitment, abortSignal) {
      connectCount += 1;
      const queue = new ScriptedQueue();
      queuesByCall.push(queue);
      const list = queuesByWallet.get(wallet) ?? [];
      list.push(queue);
      queuesByWallet.set(wallet, list);
      const ctrl = new AbortController();
      abortSignal.addEventListener("abort", () => {
        ctrl.abort();
        queue.close();
      });
      activeControllers.push(ctrl);
      return queue.iterate(abortSignal);
    },
  };

  return {
    port,
    getConnectCount: () => connectCount,
    getQueues: (wallet: WalletAddress) => queuesByWallet.get(wallet) ?? [],
    streams,
  };
}

function makeStubRpc(backfillByWallet: Map<WalletAddress, SignatureSummary[]>): SolanaRpcPort {
  return {
    async getTransaction() {
      return null;
    },
    async getSignaturesForAddress(address) {
      return backfillByWallet.get(address) ?? [];
    },
  };
}

describe("SolanaWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backfills missed txs chronologically when a cursor exists and skips pre-watch history on new quiet wallets", async () => {
    vi.useFakeTimers();
    const store = new SqliteStore(":memory:");
    store.createWallet(walletA, "Treasury");
    store.updateLastSignature(walletA, sig1);
    store.createWallet(walletB, "NewQuiet");

    const subs = createFakeSubscriptionPort();
    // RPC returns newest-first [sig3, sig2] after lastSignature sig1 for walletA,
    // and historical signatures for walletB that predate watching.
    const rpc = makeStubRpc(
      new Map([
        [
          walletA,
          [
            { signature: sig3, slot: 103n, err: null },
            { signature: sig2, slot: 102n, err: null },
          ],
        ],
        [walletB, [{ signature: sig4, slot: 50n, err: null }]],
      ]),
    );

    const seen: Array<{ wallet: WalletAddress; signature: TxSignature; source: string }> = [];
    const watcher = new SolanaWatcher({
      subscriptionPort: subs.port,
      rpcPort: rpc,
      store,
      commitment: "confirmed",
      logger: createLogger("silent"),
      backoff: { baseMs: 1_000, maxMs: 5_000 },
      rng: () => 0.5,
      onSignature: async (wallet, signature, source, signal) => {
        expect(signal.aborted).toBe(false);
        seen.push({ wallet, signature, source });
      },
    });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(subs.getQueues(walletA)).toHaveLength(1);
    expect(subs.getQueues(walletB)).toHaveLength(1);

    // Persisted cursor on walletA backfills [sig2, sig3] on startup/reconnect;
    // brand-new walletB (lastSignature === null) must NOT replay historical sig4.
    expect(seen).toEqual([
      { wallet: walletA, signature: sig2, source: "backfill" },
      { wallet: walletA, signature: sig3, source: "backfill" },
    ]);

    // Simulate live WS notification advancing cursor
    subs.getQueues(walletA)[0]?.push({ signature: sig1, slot: 101n, err: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen[2]).toEqual({ wallet: walletA, signature: sig1, source: "websocket" });

    // Drop both WS channels and verify reconnect backoff + no historical blast on walletB
    subs
      .getQueues(walletA)[0]
      ?.fail(new SolanaError(SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED));
    subs
      .getQueues(walletB)[0]
      ?.fail(new SolanaError(SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED));

    await vi.advanceTimersByTimeAsync(600);

    expect(subs.getQueues(walletA)).toHaveLength(2);
    expect(subs.getQueues(walletB)).toHaveLength(2);
    expect(watcher.getStatus().reconnectsTotal).toBe(2);
    expect(seen.some((item) => item.wallet === walletB)).toBe(false);

    // Subsequent live event after reconnect on walletA
    subs.getQueues(walletA)[1]?.push({ signature: sig4, slot: 104n, err: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.at(-1)).toEqual({ wallet: walletA, signature: sig4, source: "websocket" });

    await watcher.stop();
    expect(watcher.getStatus().running).toBe(false);
    expect(watcher.getStatus().watchedCount).toBe(0);
    store.close();
  });

  it("supports dynamic watchWallet / unwatchWallet without restarting sibling wallets", async () => {
    vi.useFakeTimers();
    const store = new SqliteStore(":memory:");
    store.createWallet(walletA, "A");

    const subs = createFakeSubscriptionPort();
    const watcher = new SolanaWatcher({
      subscriptionPort: subs.port,
      rpcPort: makeStubRpc(new Map()),
      store,
      commitment: "confirmed",
      logger: createLogger("silent"),
      onSignature: async () => {},
    });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watcher.getStatus().watchedCount).toBe(1);
    expect(subs.getQueues(walletA)).toHaveLength(1);

    store.createWallet(walletB, "B");
    await watcher.watchWallet(walletB);
    await vi.advanceTimersByTimeAsync(10);
    expect(watcher.getStatus().watchedCount).toBe(2);
    // Wallet A was NOT restarted
    expect(subs.getQueues(walletA)).toHaveLength(1);
    expect(subs.getQueues(walletB)).toHaveLength(1);

    await watcher.unwatchWallet(walletA);
    expect(watcher.getStatus().watchedCount).toBe(1);

    await watcher.stop();
    store.close();
  });
});
