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
import type { SolanaRpcPort } from "./rpcClient.js";

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

export type SignatureHandler = (
  wallet: WalletAddress,
  signature: TxSignature,
  source: "websocket" | "backfill",
  signal: AbortSignal,
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
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

type WalletTask = {
  readonly controller: AbortController;
  readonly done: Promise<void>;
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
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;

  private readonly tasks = new Map<WalletAddress, WalletTask>();
  private running = false;
  private reconnectsTotal = 0;

  constructor(options: SolanaWatcherOptions) {
    this.subscriptionPort = options.subscriptionPort;
    this.rpcPort = options.rpcPort;
    this.store = options.store;
    this.commitment = options.commitment;
    this.onSignature = options.onSignature;
    this.logger = options.logger;
    this.backoff = options.backoff ?? { baseMs: 1_000, maxMs: 30_000 };
    this.maxBackfillSignatures = options.maxBackfillSignatures ?? 25;
    this.sleep = options.sleep ?? abortableSleep;
    this.rng = options.rng ?? Math.random;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const wallets = this.store.listWallets(true);
    for (const wallet of wallets) {
      await this.watchWallet(wallet.address);
    }
    this.logger.info({ walletCount: wallets.length }, "Solana watcher started");
  }

  async watchWallet(wallet: WalletAddress): Promise<void> {
    if (this.tasks.has(wallet)) return;
    const controller = new AbortController();
    const done = this.runWalletLoop(wallet, controller.signal);
    this.tasks.set(wallet, { controller, done });
  }

  async unwatchWallet(wallet: WalletAddress): Promise<void> {
    const task = this.tasks.get(wallet);
    if (!task) return;
    this.tasks.delete(wallet);
    task.controller.abort();
    await Promise.allSettled([task.done]);
  }

  async stop(): Promise<void> {
    if (!this.running && this.tasks.size === 0) return;
    this.running = false;
    const entries = [...this.tasks.values()];
    this.tasks.clear();
    for (const entry of entries) {
      entry.controller.abort();
    }
    await Promise.allSettled(entries.map((entry) => entry.done));
    this.logger.info("Solana watcher stopped");
  }

  getStatus(): {
    readonly running: boolean;
    readonly watchedCount: number;
    readonly reconnectsTotal: number;
  } {
    return {
      running: this.running,
      watchedCount: this.tasks.size,
      reconnectsTotal: this.reconnectsTotal,
    };
  }

  private async runWalletLoop(wallet: WalletAddress, signal: AbortSignal): Promise<void> {
    let reconnectAttempt = 0;

    while (!signal.aborted) {
      try {
        const stream = await this.subscriptionPort.subscribeLogs(wallet, this.commitment, signal);

        // Catch up only when a persisted cursor exists so restarts recover downtime without replaying old history on brand-new wallets.
        const stored = this.store.getWallet(wallet);
        if (stored?.lastSignature) {
          await this.backfillMissed(wallet, stored.lastSignature, signal);
        }
        reconnectAttempt = 0;

        for await (const item of stream) {
          if (signal.aborted) break;
          await this.safeDispatchSignature(wallet, item.signature, "websocket", signal);
        }
      } catch (err) {
        if (signal.aborted || isAbortError(err)) {
          break;
        }
        const isChannelClosed = isSolanaError(
          err,
          SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED,
        );
        this.logger.warn(
          { wallet, attempt: reconnectAttempt, isChannelClosed, err },
          "Solana WebSocket subscription interrupted; scheduling reconnect",
        );
      }

      if (signal.aborted) break;
      this.reconnectsTotal += 1;
      const delayMs = computeBackoffDelayMs(reconnectAttempt, this.backoff, this.rng);
      reconnectAttempt += 1;
      await this.sleep(delayMs, signal);
    }
  }

  private async backfillMissed(
    wallet: WalletAddress,
    lastSignature: TxSignature,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const summaries = await this.rpcPort.getSignaturesForAddress(
        wallet,
        { until: lastSignature, limit: this.maxBackfillSignatures },
        signal,
      );
      // getSignaturesForAddress returns newest-first; replay oldest-first to preserve timeline.
      for (const entry of [...summaries].reverse()) {
        if (signal.aborted) break;
        await this.safeDispatchSignature(wallet, entry.signature, "backfill", signal);
      }
    } catch (err) {
      if (!signal.aborted) {
        this.logger.error({ wallet, err }, "Catch-up backfill failed after reconnect");
      }
    }
  }

  private async safeDispatchSignature(
    wallet: WalletAddress,
    signature: TxSignature,
    source: "websocket" | "backfill",
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.onSignature(wallet, signature, source, signal);
    } catch (err) {
      if (!signal.aborted) {
        this.logger.error({ wallet, signature, source, err }, "Failed handling signature");
      }
    }
  }
}
