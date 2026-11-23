import {
  createSolanaRpcSubscriptions,
  isAbortError,
  isSolanaError,
  SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED,
} from "@solana/kit";
import { abortableSleep, type BackoffOptions, computeBackoffDelayMs } from "../domain/backoff.js";
import {
  type CommitmentLevel,
  parseTxSignature,
  type TxSignature,
  type WalletAddress,
} from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { SqliteStore } from "../store/sqliteStore.js";
import type { SignatureSummary, SolanaRpcPort } from "./rpcClient.js";

export type LogNotificationItem = {
  readonly signature: TxSignature;
  readonly slot: bigint;
  readonly err: unknown;
};

export interface LogsSubscriptionPort {
  subscribeLogs(
    wallet: WalletAddress,
    commitment: CommitmentLevel,
    abortSignal: AbortSignal,
  ): Promise<AsyncIterable<LogNotificationItem>>;
}

export class KitLogsSubscriptionAdapter implements LogsSubscriptionPort {
  private readonly rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;

  constructor(wsUrl: string) {
    this.rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  }

  async subscribeLogs(
    wallet: WalletAddress,
    commitment: CommitmentLevel,
    abortSignal: AbortSignal,
  ): Promise<AsyncIterable<LogNotificationItem>> {
    const stream = await this.rpcSubscriptions
      .logsNotifications({ mentions: [wallet] }, { commitment })
      .subscribe({ abortSignal });

    return {
      async *[Symbol.asyncIterator]() {
        for await (const notification of stream) {
          yield {
            signature: parseTxSignature(notification.value.signature),
            slot: BigInt(notification.context.slot),
            err: notification.value.err,
          };
        }
      },
    };
  }
}

export type SignatureEventMeta = {
  readonly slot: bigint;
  readonly err: unknown;
  readonly advanceRpcCursor: boolean;
};

export type SignatureHandler = (
  wallet: WalletAddress,
  signature: TxSignature,
  source: "websocket" | "backfill",
  signal: AbortSignal,
  meta?: SignatureEventMeta,
) => Promise<void>;

export type SolanaWatcherOptions = {
  readonly subscriptionPort: LogsSubscriptionPort;
  readonly rpcPort: SolanaRpcPort;
  readonly store: SqliteStore;
  readonly commitment: CommitmentLevel;
  readonly onSignature: SignatureHandler;
  readonly logger: AppLogger;
  readonly backoff?: BackoffOptions | undefined;
  readonly maxBackfillSignatures?: number | undefined;
  readonly maxQueueSize?: number | undefined;
  readonly maxStagingBufferSize?: number | undefined;
  readonly workerConcurrency?: number | undefined;
  readonly watchTokenAccounts?: boolean | undefined;
  readonly maxAtasPerWallet?: number | undefined;
  readonly ataRefreshIntervalMs?: number | undefined;
  readonly startupStaggerMs?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
  readonly nowMs?: (() => number) | undefined;
};

export type WatcherStatus = {
  readonly running: boolean;
  readonly watchedCount: number;
  readonly connectedCount: number;
  readonly ataSubscriptionsCount: number;
  readonly queueDepth: number;
  readonly droppedQueueTotal: number;
  readonly backfillTruncatedTotal: number;
  readonly reconnectsTotal: number;
  readonly lastEventAtMs: number | null;
};

type QueuedWorkItem = {
  readonly wallet: WalletAddress;
  readonly signature: TxSignature;
  readonly slot: bigint;
  readonly err: unknown;
  readonly source: "websocket" | "backfill";
  readonly advanceRpcCursor: boolean;
  readonly signal: AbortSignal;
};

type WalletTask = {
  readonly controller: AbortController;
  readonly rootDone: Promise<void>;
  readonly ataLoops: Map<WalletAddress, Promise<void>>;
  readonly refreshTimer?: ReturnType<typeof setInterval> | undefined;
};

export class SolanaWatcher {
  private readonly subscriptionPort: LogsSubscriptionPort;
  private readonly rpcPort: SolanaRpcPort;
  private readonly store: SqliteStore;
  private readonly commitment: CommitmentLevel;
  private readonly onSignature: SignatureHandler;
  private readonly logger: AppLogger;
  private readonly backoff: BackoffOptions;
  private readonly maxBackfillSignatures: number;
  private readonly maxQueueSize: number;
  private readonly maxStagingBufferSize: number;
  private readonly workerConcurrency: number;
  private readonly watchTokenAccounts: boolean;
  private readonly maxAtasPerWallet: number;
  private readonly ataRefreshIntervalMs: number;
  private readonly startupStaggerMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;
  private readonly nowMs: () => number;

  private readonly tasks = new Map<WalletAddress, WalletTask>();
  private readonly activeConnections = new Set<string>();
  private readonly queue: QueuedWorkItem[] = [];
  private readonly inFlightWallets = new Map<WalletAddress, Promise<void>>();
  private activeWorkerCount = 0;

  private running = false;
  private reconnectsTotal = 0;
  private droppedQueueTotal = 0;
  private backfillTruncatedTotal = 0;
  private lastEventAtMs: number | null = null;

  constructor(options: SolanaWatcherOptions) {
    this.subscriptionPort = options.subscriptionPort;
    this.rpcPort = options.rpcPort;
    this.store = options.store;
    this.commitment = options.commitment;
    this.onSignature = options.onSignature;
    this.logger = options.logger;
    this.backoff = options.backoff ?? { baseMs: 1_000, maxMs: 30_000 };
    this.maxBackfillSignatures = options.maxBackfillSignatures ?? 500;
    this.maxQueueSize = Math.max(10, options.maxQueueSize ?? 2_000);
    this.maxStagingBufferSize = Math.max(10, options.maxStagingBufferSize ?? 500);
    this.workerConcurrency = Math.max(1, options.workerConcurrency ?? 4);
    this.watchTokenAccounts = options.watchTokenAccounts ?? true;
    this.maxAtasPerWallet = Math.max(0, options.maxAtasPerWallet ?? 50);
    this.ataRefreshIntervalMs = options.ataRefreshIntervalMs ?? 300_000;
    this.startupStaggerMs = options.startupStaggerMs ?? 25;
    this.sleep = options.sleep ?? abortableSleep;
    this.rng = options.rng ?? Math.random;
    this.nowMs = options.nowMs ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const wallets = this.store.listWallets(true);
    const staggerMs = wallets.length > 5 ? this.startupStaggerMs : 0;

    for (let i = 0; i < wallets.length; i += 1) {
      if (!this.running) break;
      const wallet = wallets[i];
      if (!wallet) continue;
      if (i > 0 && staggerMs > 0) {
        await this.sleep(staggerMs);
      }
      await this.watchWallet(wallet.address);
    }
    this.logger.info({ walletCount: wallets.length }, "Solana watcher started");
  }

  async watchWallet(wallet: WalletAddress): Promise<void> {
    if (!this.running || this.tasks.has(wallet)) return;

    const controller = new AbortController();
    const ataLoops = new Map<WalletAddress, Promise<void>>();
    const rootDone = this.runAddressLoop(wallet, wallet, true, controller.signal);

    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    if (
      this.watchTokenAccounts &&
      this.rpcPort.getTokenAccountsByOwner !== undefined &&
      this.ataRefreshIntervalMs > 0
    ) {
      refreshTimer = setInterval(() => {
        void this.syncWalletTokenAccounts(wallet);
      }, this.ataRefreshIntervalMs);
      refreshTimer.unref();
    }

    this.tasks.set(wallet, { controller, rootDone, ataLoops, refreshTimer });

    if (this.watchTokenAccounts && this.rpcPort.getTokenAccountsByOwner !== undefined) {
      void this.syncWalletTokenAccounts(wallet);
    }
  }

  async refreshWalletTokenAccounts(wallet: WalletAddress): Promise<void> {
    if (!this.running || !this.watchTokenAccounts || !this.rpcPort.getTokenAccountsByOwner) {
      return;
    }
    await this.syncWalletTokenAccounts(wallet);
  }

  async unwatchWallet(wallet: WalletAddress): Promise<void> {
    const task = this.tasks.get(wallet);
    if (!task) return;
    this.tasks.delete(wallet);
    if (task.refreshTimer) clearInterval(task.refreshTimer);
    task.controller.abort();

    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]?.wallet === wallet) {
        this.queue.splice(i, 1);
      }
    }

    const inFlight = this.inFlightWallets.get(wallet);
    await Promise.allSettled([
      task.rootDone,
      ...task.ataLoops.values(),
      ...(inFlight ? [inFlight] : []),
    ]);
  }

  async stop(): Promise<void> {
    if (!this.running && this.tasks.size === 0) return;
    this.running = false;
    const entries = [...this.tasks.values()];
    this.tasks.clear();
    this.queue.length = 0;

    for (const entry of entries) {
      if (entry.refreshTimer) clearInterval(entry.refreshTimer);
      entry.controller.abort();
    }

    await Promise.allSettled([
      ...entries.flatMap((entry) => [entry.rootDone, ...entry.ataLoops.values()]),
      ...this.inFlightWallets.values(),
    ]);
    this.activeConnections.clear();
    this.logger.info("Solana watcher stopped");
  }

  getStatus(): WatcherStatus {
    let ataSubscriptionsCount = 0;
    for (const task of this.tasks.values()) {
      ataSubscriptionsCount += task.ataLoops.size;
    }
    return {
      running: this.running,
      watchedCount: this.tasks.size,
      connectedCount: this.activeConnections.size,
      ataSubscriptionsCount,
      queueDepth: this.queue.length,
      droppedQueueTotal: this.droppedQueueTotal,
      backfillTruncatedTotal: this.backfillTruncatedTotal,
      reconnectsTotal: this.reconnectsTotal,
      lastEventAtMs: this.lastEventAtMs,
    };
  }

  private async syncWalletTokenAccounts(wallet: WalletAddress): Promise<void> {
    const getAtas = this.rpcPort.getTokenAccountsByOwner;
    const task = this.tasks.get(wallet);
    if (!getAtas || !task || task.controller.signal.aborted || !this.running) {
      return;
    }

    try {
      const atas = await getAtas.call(this.rpcPort, wallet, task.controller.signal);
      if (task.controller.signal.aborted || this.tasks.get(wallet) !== task) return;

      let subscribedCount = task.ataLoops.size;
      for (const ata of atas) {
        if (subscribedCount >= this.maxAtasPerWallet) break;
        if (ata === wallet || task.ataLoops.has(ata)) continue;

        const loopPromise = this.runAddressLoop(wallet, ata, false, task.controller.signal).finally(
          () => {
            task.ataLoops.delete(ata);
          },
        );
        task.ataLoops.set(ata, loopPromise);
        subscribedCount += 1;
      }
    } catch (err) {
      if (!task.controller.signal.aborted) {
        this.logger.warn({ wallet, err }, "Failed discovering wallet token accounts (ATAs)");
      }
    }
  }

  private enqueueWork(item: QueuedWorkItem): void {
    if (item.signal.aborted) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.droppedQueueTotal += 1;
      if (this.droppedQueueTotal === 1 || this.droppedQueueTotal % 100 === 0) {
        this.logger.warn(
          { queueDepth: this.queue.length, droppedQueueTotal: this.droppedQueueTotal },
          "Solana watcher ingestion queue full; dropping notification",
        );
      }
      return;
    }
    this.lastEventAtMs = this.nowMs();
    this.queue.push(item);
    this.scheduleWorkers();
  }

  private scheduleWorkers(): void {
    if (!this.running) return;
    while (this.activeWorkerCount < this.workerConcurrency) {
      const nextIdx = this.queue.findIndex((item) => !this.inFlightWallets.has(item.wallet));
      if (nextIdx < 0) break;

      const [nextItem] = this.queue.splice(nextIdx, 1);
      if (!nextItem) break;
      if (nextItem.signal.aborted) continue;

      this.activeWorkerCount += 1;
      const workerDone = this.processWorkItem(nextItem).finally(() => {
        if (this.inFlightWallets.get(nextItem.wallet) === workerDone) {
          this.inFlightWallets.delete(nextItem.wallet);
        }
        this.activeWorkerCount -= 1;
        this.scheduleWorkers();
      });
      this.inFlightWallets.set(nextItem.wallet, workerDone);
    }
  }

  private async processWorkItem(item: QueuedWorkItem): Promise<void> {
    if (item.signal.aborted) return;
    try {
      await this.onSignature(item.wallet, item.signature, item.source, item.signal, {
        slot: item.slot,
        err: item.err,
        advanceRpcCursor: item.advanceRpcCursor,
      });
    } catch (err) {
      if (!item.signal.aborted) {
        this.logger.error(
          { wallet: item.wallet, signature: item.signature, source: item.source, err },
          "Failed handling signature",
        );
      }
    }
  }

  private async runAddressLoop(
    watchedWallet: WalletAddress,
    targetAddress: WalletAddress,
    isRootWallet: boolean,
    walletSignal: AbortSignal,
  ): Promise<void> {
    let reconnectAttempt = 0;
    const connectionKey = `${watchedWallet}:${targetAddress}`;

    while (!walletSignal.aborted) {
      const attemptController = new AbortController();
      const attemptSignal = AbortSignal.any([walletSignal, attemptController.signal]);

      try {
        const stream = await this.subscriptionPort.subscribeLogs(
          targetAddress,
          this.commitment,
          attemptSignal,
        );

        let backfillDone = false;
        const stagingBuffer: QueuedWorkItem[] = [];
        let hasPumpError = false;
        let pumpError: unknown = null;

        // Start iterating immediately so @solana/subscribable registers before backfill executes.
        const pumpPromise = (async () => {
          try {
            for await (const item of stream) {
              if (attemptSignal.aborted) break;
              const work: QueuedWorkItem = {
                wallet: watchedWallet,
                signature: item.signature,
                slot: item.slot,
                err: item.err,
                source: "websocket",
                advanceRpcCursor: isRootWallet,
                signal: walletSignal,
              };
              if (!backfillDone) {
                if (stagingBuffer.length < this.maxStagingBufferSize) {
                  stagingBuffer.push(work);
                } else {
                  this.droppedQueueTotal += 1;
                }
              } else {
                this.enqueueWork(work);
              }
            }
          } catch (err) {
            hasPumpError = true;
            pumpError = err;
            if (!attemptSignal.aborted) {
              attemptController.abort(err);
            }
          }
        })();

        if (isRootWallet) {
          // Catch up using the persisted RPC-indexed cursor while live notifications buffer safely.
          const stored = this.store.getWallet(watchedWallet);
          const cursor = stored?.lastRpcSignature ?? stored?.lastSignature;
          if (cursor) {
            await this.backfillMissed(watchedWallet, cursor, attemptSignal);
          }
        }

        if (hasPumpError) {
          throw pumpError;
        }

        backfillDone = true;
        this.activeConnections.add(connectionKey);
        reconnectAttempt = 0;

        for (const buffered of stagingBuffer) {
          this.enqueueWork(buffered);
        }
        stagingBuffer.length = 0;

        await pumpPromise;
        if (hasPumpError) {
          throw pumpError;
        }
      } catch (err) {
        if (walletSignal.aborted) {
          break;
        }
        const isChannelClosed =
          isSolanaError(err, SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED) ||
          isAbortError(err);
        this.logger.warn(
          {
            wallet: watchedWallet,
            targetAddress,
            attempt: reconnectAttempt,
            isChannelClosed,
            err,
          },
          "Solana WebSocket subscription interrupted; scheduling reconnect",
        );
      } finally {
        this.activeConnections.delete(connectionKey);
        attemptController.abort();
      }

      if (walletSignal.aborted) break;
      this.reconnectsTotal += 1;
      const delayMs = computeBackoffDelayMs(reconnectAttempt, this.backoff, this.rng);
      reconnectAttempt += 1;
      await this.sleep(delayMs, walletSignal);
    }
  }

  private async backfillMissed(
    wallet: WalletAddress,
    untilSignature: TxSignature,
    signal: AbortSignal,
  ): Promise<void> {
    const collected: SignatureSummary[] = [];
    let before: TxSignature | undefined;

    while (!signal.aborted && collected.length < this.maxBackfillSignatures) {
      const remaining = this.maxBackfillSignatures - collected.length;
      const pageLimit = Math.min(100, remaining);
      const page = await this.rpcPort.getSignaturesForAddress(
        wallet,
        {
          until: untilSignature,
          ...(before !== undefined ? { before } : {}),
          limit: pageLimit,
        },
        signal,
      );

      if (page.length === 0) break;
      collected.push(...page);
      if (page.length < pageLimit) break;

      const oldestInPage = page.at(-1);
      if (!oldestInPage || oldestInPage.signature === before) break;
      before = oldestInPage.signature;

      if (collected.length >= this.maxBackfillSignatures) {
        this.backfillTruncatedTotal += 1;
        this.logger.warn(
          { wallet, limit: this.maxBackfillSignatures, untilSignature },
          "Catch-up backfill hit maxBackfillSignatures cap",
        );
      }
    }

    // getSignaturesForAddress returns newest-first; enqueue oldest-first to preserve timeline.
    for (const entry of [...collected].reverse()) {
      if (signal.aborted) break;
      this.enqueueWork({
        wallet,
        signature: entry.signature,
        slot: entry.slot,
        err: entry.err,
        source: "backfill",
        advanceRpcCursor: true,
        signal,
      });
    }
  }
}
