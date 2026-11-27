import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  KitLogsSubscriptionAdapter,
  type LogNotificationItem,
  type LogsSubscriptionPort,
  type SignatureEventMeta,
  SolanaWatcher,
} from "../../src/solana/watcher.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  CUSTOM_UNKNOWN_MINT,
  SIG_FAILED_TX,
  SIG_JUPITER_SWAP,
  SIG_PROGRAM_ONLY,
  SIG_RAYDIUM_SWAP,
  SIG_SOL_IN,
  SIG_SOL_OUT,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const walletB = parseWalletAddress(COUNTERPARTY_WALLET);
const ataA = parseWalletAddress(CUSTOM_UNKNOWN_MINT);
const sig1 = parseTxSignature(SIG_SOL_IN);
const sig2 = parseTxSignature(SIG_SOL_OUT);
const sig3 = parseTxSignature(SIG_JUPITER_SWAP);
const sig4 = parseTxSignature(SIG_RAYDIUM_SWAP);
const sig5 = parseTxSignature(SIG_FAILED_TX);
const sig6 = parseTxSignature(SIG_PROGRAM_ONLY);

function createFakeSubscriptionPort() {
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
          const onAbort = () => resolve();
          this.waiter = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }

  const queuesByWallet = new Map<WalletAddress, ScriptedQueue[]>();

  const port: LogsSubscriptionPort = {
    async subscribeLogs(wallet, _commitment, abortSignal) {
      const queue = new ScriptedQueue();
      const list = queuesByWallet.get(wallet) ?? [];
      list.push(queue);
      queuesByWallet.set(wallet, list);
      abortSignal.addEventListener(
        "abort",
        () => {
          queue.close();
        },
        { once: true },
      );
      return queue.iterate(abortSignal);
    },
  };

  return {
    port,
    getQueues: (wallet: WalletAddress) => queuesByWallet.get(wallet) ?? [],
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

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function startLoopbackWsServer(
  onTextFrame: (text: string, send: (payload: unknown) => void) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer();
  const sockets = new Set<import("node:stream").Duplex>();

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );

    const send = (payload: unknown) => {
      if (!socket.destroyed) {
        socket.write(encodeServerTextFrame(JSON.stringify(payload)));
      }
    };

    let rx = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 2) {
        const b0 = rx[0] ?? 0;
        const b1 = rx[1] ?? 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (rx.length < 4) break;
          len = rx.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          break;
        }
        const maskLen = masked ? 4 : 0;
        if (rx.length < offset + maskLen + len) break;

        const out = Buffer.alloc(len);
        if (masked) {
          for (let i = 0; i < len; i += 1) {
            out[i] = (rx[offset + 4 + i] ?? 0) ^ (rx[offset + (i % 4)] ?? 0);
          }
        } else {
          rx.copy(out, 0, offset, offset + len);
        }
        rx = rx.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          socket.end();
        } else if (opcode === 0x1) {
          onTextFrame(out.toString("utf8"), send);
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${addr.port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SolanaWatcher & KitLogsSubscriptionAdapter", () => {
  const openStores: SqliteStore[] = [];
  const activeWatchers: SolanaWatcher[] = [];

  const trackStore = (store: SqliteStore): SqliteStore => {
    openStores.push(store);
    return store;
  };
  const trackWatcher = (watcher: SolanaWatcher): SolanaWatcher => {
    activeWatchers.push(watcher);
    return watcher;
  };

  afterEach(async () => {
    for (const watcher of activeWatchers.splice(0)) {
      await watcher.stop();
    }
    for (const store of openStores.splice(0)) {
      store.close();
    }
    vi.useRealTimers();
  });

  it("backfills missed txs chronologically when a cursor exists and skips pre-watch history on new quiet wallets", async () => {
    vi.useFakeTimers();
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Treasury");
    store.updateLastSignature(walletA, sig1, 101n);
    store.createWallet(walletB, "NewQuiet");

    const subs = createFakeSubscriptionPort();
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
    const watcher = trackWatcher(
      new SolanaWatcher({
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
      }),
    );

    await watcher.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(subs.getQueues(walletA)).toHaveLength(1);
    expect(subs.getQueues(walletB)).toHaveLength(1);

    expect(seen).toEqual([
      { wallet: walletA, signature: sig2, source: "backfill" },
      { wallet: walletA, signature: sig3, source: "backfill" },
    ]);

    subs.getQueues(walletA)[0]?.push({ signature: sig1, slot: 101n, err: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen[2]).toEqual({ wallet: walletA, signature: sig1, source: "websocket" });

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

    subs.getQueues(walletA)[1]?.push({ signature: sig4, slot: 104n, err: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.at(-1)).toEqual({ wallet: walletA, signature: sig4, source: "websocket" });

    await watcher.stop();
    expect(watcher.getStatus().running).toBe(false);
    expect(watcher.getStatus().watchedCount).toBe(0);
  });

  it("buffers live notifications emitted before stream iteration during slow backfill (no lazy-iterator loss)", async () => {
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Treasury");
    store.updateLastSignature(walletA, sig1, 100n);

    // Simulates @solana/subscribable: drops items pushed unless [Symbol.asyncIterator]().next() was already started!
    let subscribedActive = false;
    const liveSink: { push: ((item: LogNotificationItem) => void) | null } = { push: null };

    const strictSubscriptionPort: LogsSubscriptionPort = {
      async subscribeLogs(_wallet, _commitment, abortSignal) {
        const buffer: LogNotificationItem[] = [];
        let wake: (() => void) | null = null;
        let ended = false;

        liveSink.push = (item) => {
          if (!subscribedActive) {
            return; // Dropped if lazy consumer hasn't started iterating!
          }
          buffer.push(item);
          const fn = wake;
          wake = null;
          fn?.();
        };

        abortSignal.addEventListener(
          "abort",
          () => {
            ended = true;
            const fn = wake;
            wake = null;
            fn?.();
          },
          { once: true },
        );

        return {
          async *[Symbol.asyncIterator]() {
            subscribedActive = true;
            while (!ended && !abortSignal.aborted) {
              if (buffer.length > 0) {
                const next = buffer.shift();
                if (next) yield next;
                continue;
              }
              await new Promise<void>((resolve) => {
                const onAbort = () => resolve();
                wake = () => {
                  abortSignal.removeEventListener("abort", onAbort);
                  resolve();
                };
                abortSignal.addEventListener("abort", onAbort, { once: true });
              });
            }
          },
        };
      },
    };

    const backfillDeferred: { resolve: ((rows: readonly SignatureSummary[]) => void) | null } = {
      resolve: null,
    };
    const backfillRpc: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress() {
        return await new Promise<readonly SignatureSummary[]>((resolve) => {
          backfillDeferred.resolve = resolve;
        });
      },
    };

    const delivered: Array<{ sig: TxSignature; source: string }> = [];
    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: strictSubscriptionPort,
        rpcPort: backfillRpc,
        store,
        commitment: "confirmed",
        logger: createLogger("silent"),
        watchTokenAccounts: false,
        onSignature: async (_w, sig, source) => {
          delivered.push({ sig, source });
        },
      }),
    );

    await watcher.start();
    // Wait a microtask for subscribeLogs + backfill promise suspension
    await Promise.resolve();
    await Promise.resolve();

    // Consumer MUST already be active before backfill resolves!
    expect(subscribedActive).toBe(true);
    liveSink.push?.({ signature: sig3, slot: 103n, err: null });

    backfillDeferred.resolve?.([{ signature: sig2, slot: 102n, err: null }]);
    await new Promise((r) => setTimeout(r, 25));

    expect(delivered).toEqual([
      { sig: sig2, source: "backfill" },
      { sig: sig3, source: "websocket" },
    ]);
  });

  it("paginates multi-page backfill with before cursor, tracks truncation, and retries failed backfill", async () => {
    vi.useFakeTimers();
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Paged");
    store.updateLastSignature(walletA, sig1, 100n);

    const subs = createFakeSubscriptionPort();
    let calls = 0;
    const beforeArgs: Array<TxSignature | undefined> = [];

    const rpc: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress(_addr, opts) {
        calls += 1;
        beforeArgs.push(opts?.before);
        if (calls === 1) {
          throw new Error("temporary RPC 503");
        }
        // On retry (attempt 2), paginate cleanly across 2 pages (maxBackfillSignatures: 4)
        if (!opts?.before) {
          return [
            { signature: sig5, slot: 105n, err: null },
            { signature: sig4, slot: 104n, err: null },
            { signature: sig3, slot: 103n, err: null },
            { signature: sig2, slot: 102n, err: null },
          ];
        }
        return [];
      },
    };

    const seen: TxSignature[] = [];
    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: subs.port,
        rpcPort: rpc,
        store,
        commitment: "confirmed",
        logger: createLogger("silent"),
        backoff: { baseMs: 100, maxMs: 200 },
        rng: () => 0.5,
        maxBackfillSignatures: 4,
        onSignature: async (_w, sig) => {
          seen.push(sig);
        },
      }),
    );

    await watcher.start();
    await vi.advanceTimersByTimeAsync(150);

    // Failed initial backfill triggered reconnect attempt 1 and succeeded cleanly without advancing cursor over gap
    expect(watcher.getStatus().reconnectsTotal).toBe(1);
    expect(watcher.getStatus().backfillTruncatedTotal).toBe(0);
    expect(seen).toEqual([sig2, sig3, sig4, sig5]);
  });

  it("increments backfillTruncatedTotal only when older signatures exist beyond maxBackfillSignatures", async () => {
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Truncated");
    store.updateLastSignature(walletA, sig1, 100n);

    const subs = createFakeSubscriptionPort();
    const rpc: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress(_addr, opts) {
        if (!opts?.before) {
          return [
            { signature: sig5, slot: 105n, err: null },
            { signature: sig4, slot: 104n, err: null },
          ];
        }
        return [{ signature: sig3, slot: 103n, err: null }];
      },
    };

    const seen: TxSignature[] = [];
    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: subs.port,
        rpcPort: rpc,
        store,
        commitment: "confirmed",
        logger: createLogger("silent"),
        backoff: { baseMs: 50, maxMs: 100 },
        maxBackfillSignatures: 2,
        onSignature: async (_w, sig) => {
          seen.push(sig);
        },
      }),
    );

    await watcher.start();
    await vi.waitFor(() => {
      expect(watcher.getStatus().backfillTruncatedTotal).toBe(1);
    });
    expect(seen).toEqual([sig4, sig5]);
  });

  it("discovers wallet ATAs dynamically (advanceRpcCursor: false), guards stop/watchWallet race, and bounds queue overflow", async () => {
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "Root");

    const subs = createFakeSubscriptionPort();
    const rpc: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress() {
        return [];
      },
      async getTokenAccountsByOwner() {
        return [ataA];
      },
    };

    const firstWorkerGate: { release: (() => void) | null } = { release: null };
    const eventsMeta: Array<{ sig: TxSignature; meta: SignatureEventMeta | undefined }> = [];
    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: subs.port,
        rpcPort: rpc,
        store,
        commitment: "confirmed",
        logger: createLogger("silent"),
        maxQueueSize: 10,
        ataRefreshIntervalMs: 0,
        onSignature: async (_w, sig, _src, signal, meta) => {
          eventsMeta.push({ sig, meta });
          if (sig === sig1 && !signal.aborted) {
            await new Promise<void>((resolve) => {
              const onAbort = () => resolve();
              firstWorkerGate.release = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              };
              signal.addEventListener("abort", onAbort, { once: true });
            });
          }
        },
      }),
    );

    // Calling watchWallet before start() must be ignored (fixes zombie loop race)
    await watcher.watchWallet(walletB);
    expect(watcher.getStatus().watchedCount).toBe(0);

    await watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.getStatus().ataSubscriptionsCount).toBe(1);
    expect(subs.getQueues(ataA)).toHaveLength(1);

    // Push ATA event -> must report advanceRpcCursor: false
    subs.getQueues(ataA)[0]?.push({ signature: sig2, slot: 202n, err: null });
    await new Promise((r) => setTimeout(r, 15));
    expect(eventsMeta.find((e) => e.sig === sig2)?.meta?.advanceRpcCursor).toBe(false);

    // Hold worker on root wallet while pushing > maxQueueSize (10) items -> excess safely dropped
    try {
      subs.getQueues(walletA)[0]?.push({ signature: sig1, slot: 201n, err: null });
      await new Promise((r) => setTimeout(r, 15));
      for (let i = 0; i < 15; i += 1) {
        subs.getQueues(walletA)[0]?.push({ signature: sig6, slot: BigInt(300 + i), err: null });
      }
      await new Promise((r) => setTimeout(r, 15));
      expect(watcher.getStatus().droppedQueueTotal).toBeGreaterThan(0);
    } finally {
      firstWorkerGate.release?.();
    }

    await watcher.unwatchWallet(walletA);
    expect(watcher.getStatus().watchedCount).toBe(0);
  });

  it("supports dynamic watchWallet / unwatchWallet without restarting sibling wallets", async () => {
    vi.useFakeTimers();
    const store = trackStore(new SqliteStore(":memory:"));
    store.createWallet(walletA, "A");

    const subs = createFakeSubscriptionPort();
    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: subs.port,
        rpcPort: makeStubRpc(new Map()),
        store,
        commitment: "confirmed",
        logger: createLogger("silent"),
        onSignature: async () => {},
      }),
    );

    await watcher.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watcher.getStatus().watchedCount).toBe(1);
    expect(subs.getQueues(walletA)).toHaveLength(1);

    store.createWallet(walletB, "B");
    await watcher.watchWallet(walletB);
    await vi.advanceTimersByTimeAsync(10);
    expect(watcher.getStatus().watchedCount).toBe(2);
    expect(subs.getQueues(walletA)).toHaveLength(1);
    expect(subs.getQueues(walletB)).toHaveLength(1);

    await watcher.unwatchWallet(walletA);
    expect(watcher.getStatus().watchedCount).toBe(1);

    await watcher.stop();
  });

  it("connects KitLogsSubscriptionAdapter over local WebSocket wire protocol, parses logsNotification, and sends logsUnsubscribe on abort", async () => {
    const receivedRequests: Array<Record<string, unknown>> = [];
    const serverSender: { send: ((payload: unknown) => void) | null } = { send: null };
    let nextSubId = 41;

    const wsMock = await startLoopbackWsServer((text, send) => {
      serverSender.send = send;
      const msg = JSON.parse(text) as Record<string, unknown>;
      receivedRequests.push(msg);

      if (msg.method === "logsSubscribe") {
        nextSubId += 1;
        send({ jsonrpc: "2.0", id: msg.id, result: nextSubId });
      } else if (msg.method === "logsUnsubscribe") {
        send({ jsonrpc: "2.0", id: msg.id, result: true });
      }
    });

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    try {
      const adapter = new KitLogsSubscriptionAdapter(wsMock.url);
      // Keep a second pooled subscription open so aborting subscription A tests logsUnsubscribe before closing socket.
      const streamA = await adapter.subscribeLogs(walletA, "confirmed", controllerA.signal);
      const streamB = await adapter.subscribeLogs(walletB, "confirmed", controllerB.signal);
      void streamB;

      const items: LogNotificationItem[] = [];
      const consumeA = (async () => {
        for await (const item of streamA) {
          items.push(item);
          controllerA.abort();
          break;
        }
      })();

      await Promise.resolve();
      serverSender.send?.({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 42,
          result: {
            context: { slot: 310_000_777 },
            value: { signature: SIG_SOL_IN, err: null, logs: [] },
          },
        },
      });

      await consumeA;
      await new Promise((r) => setTimeout(r, 20));
      controllerB.abort();
      await new Promise((r) => setTimeout(r, 15));

      expect(items).toEqual([{ signature: sig1, slot: 310_000_777n, err: null }]);
      expect(receivedRequests[0]?.method).toBe("logsSubscribe");
      expect(receivedRequests[0]?.params).toEqual([
        { mentions: [walletA] },
        { commitment: "confirmed" },
      ]);
      expect(receivedRequests.some((req) => req.method === "logsUnsubscribe")).toBe(true);
    } finally {
      controllerA.abort();
      controllerB.abort();
      await wsMock.close();
    }
  });

  it("survives onSignature errors and tracks staging buffer drop count under backfill congestion", async () => {
    const subs = createFakeSubscriptionPort();
    const store = new SqliteStore(":memory:");
    store.createWallet(walletA, "Target A");
    // Set a prior cursor to force backfillMissed to run
    store.updateLastSignature(walletA, sig1, 101n);

    let backfillGateResolve: () => void = () => {};
    const backfillGate = new Promise<void>((resolve) => {
      backfillGateResolve = resolve;
    });

    const rpcPort: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress() {
        await backfillGate;
        return [];
      },
    };

    let signatureErrorLogged = false;
    const testLogger = {
      ...createLogger("silent"),
      error: () => {
        signatureErrorLogged = true;
      },
    };

    const watcher = trackWatcher(
      new SolanaWatcher({
        subscriptionPort: subs.port,
        rpcPort,
        store,
        commitment: "confirmed",
        startupStaggerMs: 0,
        logger: testLogger as unknown as ReturnType<typeof createLogger>,
        maxStagingBufferSize: 1,
        onSignature: async (_w, sig) => {
          if (sig === sig2) {
            throw new Error("Simulated onSignature handler crash");
          }
        },
      }),
    );

    await watcher.start();
    await new Promise((r) => setTimeout(r, 20));

    const queues = subs.getQueues(walletA);
    expect(queues).toHaveLength(1);

    // Push 15 live notifications while backfill is waiting on the gate (> maxStagingBufferSize 10)
    for (let i = 0; i < 15; i += 1) {
      queues[0]?.push({
        signature: i === 0 ? sig2 : sig3,
        slot: BigInt(310_000_100 + i),
        err: null,
      });
    }

    // Allow microtasks to pump the stream into stagingBuffer while backfill is still blocked
    await new Promise((r) => setTimeout(r, 25));

    // Open gate and let backfill and staging drain
    backfillGateResolve();
    await new Promise((r) => setTimeout(r, 60));

    expect(signatureErrorLogged).toBe(true);
    expect(watcher.getStatus().droppedQueueTotal).toBeGreaterThan(0);
    await watcher.stop();
  });
});
