import { ASSOCIATED_TOKEN_PROGRAM, classifyParsedTransaction } from "../domain/classifier.js";
import { LimitExceededError } from "../domain/errors.js";
import { type CooldownStore, evaluateAlertRules } from "../domain/rules.js";
import { LAMPORTS_PER_SOL, WSOL_MINT } from "../domain/tokens.js";
import {
  type AlertRule,
  type EventType,
  type MintAddress,
  type OnChainEvent,
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
  type RuleId,
  type TxSignature,
  type WalletAddress,
  type WatchedWallet,
} from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { AlertDispatcher, TrackedDispatchResult } from "../notifiers/dispatcher.js";
import { solscanTxUrl, summarizeEvent } from "../notifiers/format.js";
import type { AlertEnvelope, DeliveryResult } from "../notifiers/types.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import type { SolanaRpcPort } from "../solana/rpcClient.js";
import type { TokenEnricherPort } from "../solana/tokenEnricher.js";
import type { SignatureEventMeta } from "../solana/watcher.js";
import type { SqliteStore } from "../store/sqliteStore.js";

const TEST_SIGNATURE = parseTxSignature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
);
const DEFAULT_TEST_WALLET = parseWalletAddress("So11111111111111111111111111111111111111112");
const MAX_STREAM_BUFFER = 50;
const MAX_STREAM_SUBSCRIBERS = 50;

export type MonitorStreamEvent =
  | {
      readonly kind: "tx_dispatched";
      readonly timestampIso: string;
      readonly deliveryId: string;
      readonly wallet: WalletAddress;
      readonly walletLabel: string | null;
      readonly signature: TxSignature;
      readonly eventKind: EventType;
      readonly summary: string;
      readonly estimatedUsd: number | null;
      readonly explorerUrl: string;
      readonly mint?: MintAddress | undefined;
      readonly results: readonly DeliveryResult[];
      readonly source: NonNullable<AlertEnvelope["source"]>;
    }
  | {
      readonly kind: "tx_filtered";
      readonly timestampIso: string;
      readonly wallet: WalletAddress;
      readonly walletLabel: string | null;
      readonly signature: TxSignature;
      readonly eventKind: EventType;
      readonly reason: string;
      readonly summary: string;
      readonly mint?: MintAddress | undefined;
    }
  | {
      readonly kind: "tx_deduped";
      readonly timestampIso: string;
      readonly wallet: WalletAddress;
      readonly signature: TxSignature;
    }
  | {
      readonly kind: "wallet_updated";
      readonly timestampIso: string;
      readonly action: "added" | "updated" | "removed";
      readonly wallet: WalletAddress;
    }
  | {
      readonly kind: "rule_updated";
      readonly timestampIso: string;
      readonly action: "upserted" | "deleted";
      readonly ruleId: RuleId;
    };

export interface WalletWatchControl {
  watchWallet(address: WalletAddress): Promise<void>;
  unwatchWallet(address: WalletAddress): Promise<void>;
  refreshWalletTokenAccounts?(address: WalletAddress): Promise<void>;
}

export type ProcessOutcome =
  | { readonly status: "dispatched"; readonly results: readonly DeliveryResult[] }
  | { readonly status: "deduped" }
  | { readonly status: "filtered"; readonly reason: string }
  | { readonly status: "not_found" };

export type ServiceMetrics = {
  readonly processedTotal: number;
  readonly dispatchedTotal: number;
  readonly deliverySucceededTotal: number;
  readonly deliveryFailedTotal: number;
  readonly dedupedTotal: number;
  readonly filteredTotal: number;
  readonly notFoundTotal: number;
  readonly directQueueDepth: number;
  readonly directQueueDroppedTotal: number;
  readonly outboxPendingCount: number;
  readonly pendingSignaturesCount: number;
};

export type DefaultRuleConfig = {
  readonly minSolLamports: bigint;
  readonly defaultMinUsd?: number | null | undefined;
  readonly includeFailed: boolean;
  readonly cooldownSeconds: number;
};

export type MonitorServiceOptions = {
  readonly store: SqliteStore;
  readonly rpcPort: SolanaRpcPort;
  readonly dispatcher: AlertDispatcher;
  readonly logger: AppLogger;
  readonly watchControl?: WalletWatchControl | undefined;
  readonly tokenEnricher?: TokenEnricherPort | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly maxWatchedWallets?: number | undefined;
  readonly maxDirectQueueSize?: number | undefined;
  readonly directWorkerConcurrency?: number | undefined;
  readonly outboxIntervalMs?: number | undefined;
  readonly pendingRetryIntervalMs?: number | undefined;
  readonly maintenanceIntervalMs?: number | undefined;
};

type QueuedDirectEvent = {
  readonly event: OnChainEvent;
  readonly signal: AbortSignal | undefined;
};

class SqliteCooldownStore implements CooldownStore {
  constructor(private readonly store: SqliteStore) {}

  isOnCooldown(
    wallet: WalletAddress,
    eventType: EventType,
    cooldownSeconds: number,
    nowMs: number,
    ruleId?: RuleId,
  ): boolean {
    if (cooldownSeconds <= 0 || ruleId === undefined) return false;
    const prev = this.store.getRuleCooldown(ruleId, wallet, eventType);
    if (prev === null) return false;
    return nowMs - prev < cooldownSeconds * 1_000;
  }

  record(wallet: WalletAddress, eventType: EventType, nowMs: number, ruleId?: RuleId): void {
    if (ruleId === undefined) return;
    this.store.setRuleCooldown(ruleId, wallet, eventType, nowMs);
  }
}

export class MonitorService {
  private readonly store: SqliteStore;
  private readonly rpcPort: SolanaRpcPort;
  private readonly dispatcher: AlertDispatcher;
  private readonly logger: AppLogger;
  private readonly cooldownStore: CooldownStore;
  private readonly nowMs: () => number;
  private readonly maxWatchedWallets: number;
  private readonly maxDirectQueueSize: number;
  private readonly directWorkerConcurrency: number;
  private readonly outboxIntervalMs: number;
  private readonly pendingRetryIntervalMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly tokenEnricher: TokenEnricherPort | undefined;
  private watchControl: WalletWatchControl | undefined;

  private cachedCatalogVersion = -1;
  private cachedEnabledWallets = new Set<WalletAddress>();

  private readonly recentStreamEvents: MonitorStreamEvent[] = [];
  private readonly streamListeners = new Set<(event: MonitorStreamEvent) => void>();

  private readonly directQueue: QueuedDirectEvent[] = [];
  private readonly directInFlightWallets = new Map<WalletAddress, Promise<unknown>>();
  private activeDirectWorkers = 0;
  private readonly drainWaiters: Array<() => void> = [];

  private outboxTimer: ReturnType<typeof setInterval> | undefined;
  private pendingTimer: ReturnType<typeof setInterval> | undefined;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private outboxRunning = false;
  private pendingRunning = false;

  private processedTotal = 0;
  private dispatchedTotal = 0;
  private deliverySucceededTotal = 0;
  private deliveryFailedTotal = 0;
  private dedupedTotal = 0;
  private filteredTotal = 0;
  private notFoundTotal = 0;
  private directQueueDroppedTotal = 0;

  constructor(options: MonitorServiceOptions) {
    this.store = options.store;
    this.rpcPort = options.rpcPort;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger;
    this.cooldownStore = new SqliteCooldownStore(this.store);
    this.nowMs = options.nowMs ?? Date.now;
    this.maxWatchedWallets = Math.max(1, options.maxWatchedWallets ?? 100);
    this.maxDirectQueueSize = Math.max(10, options.maxDirectQueueSize ?? 2_000);
    this.directWorkerConcurrency = Math.max(1, options.directWorkerConcurrency ?? 4);
    this.outboxIntervalMs = options.outboxIntervalMs ?? 5_000;
    this.pendingRetryIntervalMs = options.pendingRetryIntervalMs ?? 2_000;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 3_600_000;
    this.tokenEnricher = options.tokenEnricher;
    this.watchControl = options.watchControl;
  }

  attachWatchControl(control: WalletWatchControl): void {
    this.watchControl = control;
  }

  getRecentStreamEvents(): readonly MonitorStreamEvent[] {
    return [...this.recentStreamEvents];
  }

  subscribeEvents(listener: (event: MonitorStreamEvent) => void): () => void {
    if (this.streamListeners.size >= MAX_STREAM_SUBSCRIBERS) {
      const oldest = this.streamListeners.values().next().value;
      if (oldest) {
        this.streamListeners.delete(oldest);
      }
    }
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  private emitStreamEvent(event: MonitorStreamEvent): void {
    if (
      event.kind === "tx_dispatched" ||
      event.kind === "tx_filtered" ||
      event.kind === "tx_deduped"
    ) {
      this.recentStreamEvents.unshift(event);
      if (this.recentStreamEvents.length > MAX_STREAM_BUFFER) {
        this.recentStreamEvents.length = MAX_STREAM_BUFFER;
      }
    }
    for (const listener of this.streamListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn({ err }, "Live event subscriber threw an error");
      }
    }
  }

  ensureDefaultGlobalRule(defaults: DefaultRuleConfig): void {
    const existing = this.store.listAllRules();
    const globalId = parseRuleId("global-default");
    if (existing.length > 0 && !this.store.isRuleManagedByEnv(globalId)) {
      this.logger.info("Skipping env default rule sync; custom rules are active");
      return;
    }

    const defaultRule: AlertRule = {
      id: globalId,
      walletAddress: null,
      minSolLamports: defaults.minSolLamports,
      minUsd: defaults.defaultMinUsd ?? null,
      eventTypes: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"],
      mintAllowlist: [],
      mintDenylist: [],
      includeFailed: defaults.includeFailed,
      cooldownSeconds: defaults.cooldownSeconds,
      enabled: true,
    };
    this.store.upsertRule(defaultRule, { managedByEnv: true });
    this.logger.info(
      {
        ruleId: globalId,
        minSolLamports: defaults.minSolLamports.toString(),
        minUsd: defaultRule.minUsd,
      },
      "Synced default global rule from environment",
    );
  }

  upsertRule(rule: AlertRule, options: { readonly managedByEnv?: boolean | undefined } = {}): void {
    this.store.upsertRule(rule, { managedByEnv: options.managedByEnv ?? false });
    this.emitStreamEvent({
      kind: "rule_updated",
      timestampIso: new Date(this.nowMs()).toISOString(),
      action: "upserted",
      ruleId: rule.id,
    });
  }

  deleteRule(id: RuleId): boolean {
    const deleted = this.store.deleteRule(id);
    if (deleted) {
      this.emitStreamEvent({
        kind: "rule_updated",
        timestampIso: new Date(this.nowMs()).toISOString(),
        action: "deleted",
        ruleId: id,
      });
    }
    return deleted;
  }

  private resolveMutableGlobalRule(defaultMinSolLamports: bigint): AlertRule {
    const globalId = parseRuleId("global-default");
    return (
      this.store.getRule(globalId) ??
      this.store.listAllRules().find((r) => r.walletAddress === null) ?? {
        id: globalId,
        walletAddress: null,
        minSolLamports: defaultMinSolLamports,
        minUsd: null,
        eventTypes: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"] as const,
        mintAllowlist: [] as const,
        mintDenylist: [] as const,
        includeFailed: false,
        cooldownSeconds: 0,
        enabled: true,
      }
    );
  }

  denylistMintGlobal(mint: MintAddress): AlertRule {
    const target = this.resolveMutableGlobalRule(0n);
    const nextDenylist = target.mintDenylist.includes(mint)
      ? target.mintDenylist
      : [...target.mintDenylist, mint];
    const updated: AlertRule = {
      ...target,
      mintDenylist: nextDenylist,
    };
    this.upsertRule(updated, { managedByEnv: false });
    return updated;
  }

  updateGlobalMinSol(minSolLamports: bigint): AlertRule {
    const target = this.resolveMutableGlobalRule(minSolLamports);
    const updated: AlertRule = {
      ...target,
      minSolLamports,
    };
    this.upsertRule(updated, { managedByEnv: false });
    return updated;
  }

  async sendTestAlert(
    walletAddress?: WalletAddress,
    signal?: AbortSignal,
  ): Promise<TrackedDispatchResult> {
    const targetWallet =
      (walletAddress ? this.store.getWallet(walletAddress) : null) ??
      this.store.listWallets()[0] ??
      null;
    const address = walletAddress ?? targetWallet?.address ?? DEFAULT_TEST_WALLET;
    const walletLabel = targetWallet?.label ?? "Solwatch Test";

    const testEvent: OnChainEvent = {
      kind: "sol_transfer",
      signature: TEST_SIGNATURE,
      slot: 315_000_000n,
      timestampSec: Math.floor(this.nowMs() / 1_000),
      wallet: address,
      direction: "in",
      counterparty: DEFAULT_TEST_WALLET,
      lamports: LAMPORTS_PER_SOL + LAMPORTS_PER_SOL / 4n,
      feeLamports: 5_000n,
      success: true,
    };

    const enriched = await this.enrichSafe(testEvent, signal);
    const tracked = await this.dispatcher.dispatchTracked(enriched.event, walletLabel, signal, {
      estimatedUsd: enriched.estimatedUsd,
      source: "test",
    });

    this.emitStreamEvent({
      kind: "tx_dispatched",
      timestampIso: new Date(this.nowMs()).toISOString(),
      deliveryId: tracked.deliveryId,
      wallet: address,
      walletLabel,
      signature: enriched.event.signature,
      eventKind: enriched.event.kind,
      summary: summarizeEvent(enriched.event, enriched.estimatedUsd),
      estimatedUsd: enriched.estimatedUsd,
      explorerUrl: solscanTxUrl(enriched.event.signature, "mainnet-beta"),
      results: tracked.results,
      source: "test",
    });

    return tracked;
  }

  getEnabledWalletSet(): ReadonlySet<WalletAddress> {
    const version = this.store.getWalletCatalogVersion();
    if (version !== this.cachedCatalogVersion) {
      this.cachedEnabledWallets = new Set(this.store.listWallets(true).map((w) => w.address));
      this.cachedCatalogVersion = version;
    }
    return this.cachedEnabledWallets;
  }

  async addWallet(address: WalletAddress, label: string | null = null): Promise<WatchedWallet> {
    const normalizedLabel = label !== null ? sanitizeControlChars(label, 80) || null : null;
    if (
      this.store.getWallet(address) === null &&
      this.store.countWallets() >= this.maxWatchedWallets
    ) {
      throw new LimitExceededError(
        `Maximum watched wallets limit (${this.maxWatchedWallets}) reached`,
        { maxWatchedWallets: this.maxWatchedWallets },
      );
    }
    const created = this.store.createWallet(address, normalizedLabel);
    await this.watchControl?.watchWallet(address);
    this.emitStreamEvent({
      kind: "wallet_updated",
      timestampIso: new Date(this.nowMs()).toISOString(),
      action: "added",
      wallet: address,
    });
    this.logger.info({ wallet: address, label: normalizedLabel }, "Wallet added to watchlist");
    return created;
  }

  async updateWallet(
    address: WalletAddress,
    patch: { readonly label?: string | null | undefined; readonly enabled?: boolean | undefined },
  ): Promise<WatchedWallet | null> {
    const before = this.store.getWallet(address);
    const sanitizedPatch =
      patch.label !== undefined
        ? {
            ...patch,
            label: patch.label !== null ? sanitizeControlChars(patch.label, 80) || null : null,
          }
        : patch;
    const updated = this.store.updateWallet(address, sanitizedPatch);
    if (!updated) return null;

    if (before && before.enabled !== updated.enabled) {
      if (updated.enabled) {
        await this.watchControl?.watchWallet(address);
      } else {
        await this.watchControl?.unwatchWallet(address);
      }
    }
    this.emitStreamEvent({
      kind: "wallet_updated",
      timestampIso: new Date(this.nowMs()).toISOString(),
      action: "updated",
      wallet: address,
    });
    this.logger.info({ wallet: address, enabled: updated.enabled }, "Wallet updated");
    return updated;
  }

  async removeWallet(address: WalletAddress): Promise<boolean> {
    await this.watchControl?.unwatchWallet(address);
    const removed = this.store.removeWallet(address);
    if (removed) {
      this.emitStreamEvent({
        kind: "wallet_updated",
        timestampIso: new Date(this.nowMs()).toISOString(),
        action: "removed",
        wallet: address,
      });
      this.logger.info({ wallet: address }, "Wallet removed from watchlist");
    }
    return removed;
  }

  async processSignature(
    wallet: WalletAddress,
    signature: TxSignature,
    signal?: AbortSignal,
    meta?: SignatureEventMeta,
  ): Promise<ProcessOutcome> {
    this.processedTotal += 1;

    const existingWallet = this.store.getWallet(wallet);
    if (!existingWallet) {
      this.filteredTotal += 1;
      return { status: "filtered", reason: "wallet_unwatched" };
    }
    if (!existingWallet.enabled) {
      this.filteredTotal += 1;
      return { status: "filtered", reason: "wallet_paused" };
    }

    // Short-circuit failed txs when WS logsNotification / getSignaturesForAddress already reported err.
    if (meta !== undefined && meta.err !== null && meta.err !== undefined) {
      if (!this.walletMayAlertOnFailedTx(wallet)) {
        const claim = this.store.claimSignatureAndAdvanceCursor({
          wallet,
          signature,
          slot: meta.slot,
          eventKind: "program_interaction",
          advanceRpcCursor: meta.advanceRpcCursor,
        });
        if (claim.status === "deduped") {
          this.dedupedTotal += 1;
          return { status: "deduped" };
        }
        if (claim.status === "paused") {
          this.filteredTotal += 1;
          return { status: "filtered", reason: "wallet_paused" };
        }
        if (claim.status === "unwatched") {
          this.filteredTotal += 1;
          return { status: "filtered", reason: "wallet_unwatched" };
        }
        this.filteredTotal += 1;
        return { status: "filtered", reason: "failed_tx_suppressed" };
      }
    }

    const rawTx = await this.rpcPort.getTransaction(signature, signal);
    if (rawTx === null) {
      this.notFoundTotal += 1;
      if (meta !== undefined && !signal?.aborted) {
        this.store.enqueuePendingSignature({
          walletAddress: wallet,
          signature,
          slot: meta.slot,
          source: meta.advanceRpcCursor ? "websocket" : "backfill",
          advanceRpcCursor: meta.advanceRpcCursor,
          nextRetryAtMs: this.nowMs() + 1_000,
        });
      }
      this.logger.debug({ wallet, signature }, "Transaction not yet indexed or missing on RPC");
      return { status: "not_found" };
    }

    const event = classifyParsedTransaction(rawTx, wallet);
    const touchesAtaProgram =
      rawTx.programIds.includes(ASSOCIATED_TOKEN_PROGRAM) ||
      (rawTx.meta.innerInstructions?.includes(ASSOCIATED_TOKEN_PROGRAM) ?? false);
    if (touchesAtaProgram && this.watchControl?.refreshWalletTokenAccounts) {
      void this.watchControl.refreshWalletTokenAccounts(wallet).catch((err: unknown) => {
        this.logger.warn({ wallet, err }, "Failed refreshing ATAs after token account creation");
      });
    }

    const source = meta && !meta.advanceRpcCursor ? "backfill" : "websocket";
    return this.applyDedupeRulesAndDispatch(event, meta?.advanceRpcCursor ?? true, signal, source);
  }

  async processDirectEvent(event: OnChainEvent, signal?: AbortSignal): Promise<ProcessOutcome> {
    this.processedTotal += 1;
    // Direct webhook events can include SPL ATA transfers absent from getSignaturesForAddress(root).
    return this.applyDedupeRulesAndDispatch(event, false, signal, "webhook");
  }

  enqueueDirectEvents(
    events: readonly OnChainEvent[],
    signal?: AbortSignal,
  ): { readonly queued: number; readonly dropped: number } {
    let queued = 0;
    let dropped = 0;
    for (const event of events) {
      if (this.directQueue.length >= this.maxDirectQueueSize) {
        dropped += 1;
        this.directQueueDroppedTotal += 1;
        continue;
      }
      this.directQueue.push({ event, signal });
      queued += 1;
    }

    if (dropped > 0) {
      this.logger.warn(
        { dropped, directQueueDepth: this.directQueue.length },
        "Webhook ingestion queue full; dropped excess direct events",
      );
    }

    this.scheduleDirectWorkers();
    return { queued, dropped };
  }

  async drain(timeoutMs: number = 5_000): Promise<void> {
    if (this.directQueue.length === 0 && this.directInFlightWallets.size === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        const idx = this.drainWaiters.indexOf(done);
        if (idx >= 0) this.drainWaiters.splice(idx, 1);
        resolve();
      };
      this.drainWaiters.push(done);
      timer = setTimeout(done, timeoutMs);
      timer.unref();
    });
  }

  async processOutbox(signal?: AbortSignal): Promise<number> {
    if (this.outboxRunning || signal?.aborted) return 0;
    this.outboxRunning = true;
    let processed = 0;

    try {
      const dueItems = this.store.listDueOutboxItems(this.nowMs(), 25);
      for (const item of dueItems) {
        if (signal?.aborted) break;
        const wallet = this.store.getWallet(item.walletAddress);
        if (!wallet?.enabled) {
          this.store.markOutboxSent(item.id);
          continue;
        }

        const result = await this.dispatcher.dispatchToChannel(
          item.channel,
          item.event,
          wallet.label,
          item.deliveryId,
          signal,
        );
        processed += 1;

        if (result.status === "sent") {
          this.store.markOutboxSent(item.id);
          this.deliverySucceededTotal += 1;
        } else {
          const nextAttempts = item.attempts + 1;
          const backoffMs = Math.min(900_000, 15_000 * 2 ** item.attempts);
          this.store.rescheduleOutboxItem(
            item.id,
            nextAttempts,
            item.maxAttempts,
            this.nowMs() + backoffMs,
            result.errorMessage ?? "Delivery failed",
          );
        }
      }
    } finally {
      this.outboxRunning = false;
    }

    return processed;
  }

  async processPendingSignatures(signal?: AbortSignal): Promise<number> {
    if (this.pendingRunning || signal?.aborted) return 0;
    this.pendingRunning = true;
    let resolved = 0;

    try {
      const due = this.store.listDuePendingSignatures(this.nowMs(), 25);
      for (const item of due) {
        if (signal?.aborted) break;
        const wallet = this.store.getWallet(item.walletAddress);
        if (!wallet?.enabled) {
          this.store.deletePendingSignature(item.walletAddress, item.signature);
          continue;
        }

        const rawTx = await this.rpcPort.getTransaction(item.signature, signal);
        if (rawTx === null) {
          const nextAttempts = item.attempts + 1;
          if (nextAttempts >= 5) {
            this.store.deletePendingSignature(item.walletAddress, item.signature);
            this.logger.debug(
              { wallet: item.walletAddress, signature: item.signature },
              "Dropped pending signature after exhausting RPC indexing retries",
            );
          } else {
            this.store.reschedulePendingSignature(
              item.walletAddress,
              item.signature,
              nextAttempts,
              this.nowMs() + 1_000 * 2 ** nextAttempts,
            );
          }
          continue;
        }

        const event = classifyParsedTransaction(rawTx, item.walletAddress);
        await this.applyDedupeRulesAndDispatch(event, item.advanceRpcCursor, signal, item.source);
        resolved += 1;
      }
    } finally {
      this.pendingRunning = false;
    }

    return resolved;
  }

  runMaintenance(): void {
    try {
      const pruned = this.store.pruneHistory();
      this.store.checkpoint("PASSIVE");
      if (pruned.processedDeleted > 0 || pruned.deliveriesDeleted > 0) {
        this.logger.info(pruned, "SQLite retention pruning completed");
      }
    } catch (err) {
      this.logger.error({ err }, "SQLite background maintenance failed");
    }
  }

  startBackgroundWorkers(signal?: AbortSignal): void {
    this.stopBackgroundWorkers();

    this.outboxTimer = setInterval(() => {
      void this.processOutbox(signal).catch((err: unknown) => {
        this.logger.error({ err }, "Outbox retry worker failed");
      });
    }, this.outboxIntervalMs);
    this.outboxTimer.unref();

    this.pendingTimer = setInterval(() => {
      void this.processPendingSignatures(signal).catch((err: unknown) => {
        this.logger.error({ err }, "Pending signature retry worker failed");
      });
    }, this.pendingRetryIntervalMs);
    this.pendingTimer.unref();

    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance();
    }, this.maintenanceIntervalMs);
    this.maintenanceTimer.unref();
  }

  stopBackgroundWorkers(): void {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = undefined;
    }
    if (this.pendingTimer) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
  }

  getMetrics(): ServiceMetrics {
    return {
      processedTotal: this.processedTotal,
      dispatchedTotal: this.dispatchedTotal,
      deliverySucceededTotal: this.deliverySucceededTotal,
      deliveryFailedTotal: this.deliveryFailedTotal,
      dedupedTotal: this.dedupedTotal,
      filteredTotal: this.filteredTotal,
      notFoundTotal: this.notFoundTotal,
      directQueueDepth: this.directQueue.length,
      directQueueDroppedTotal: this.directQueueDroppedTotal,
      outboxPendingCount: this.store.countPendingOutbox(),
      pendingSignaturesCount: this.store.countPendingSignatures(),
    };
  }

  private walletMayAlertOnFailedTx(wallet: WalletAddress): boolean {
    const enabledRules = this.store.listRulesForWallet(wallet).filter((r) => r.enabled);
    const walletSpecific = enabledRules.filter((r) => r.walletAddress === wallet);
    const applicable =
      walletSpecific.length > 0
        ? walletSpecific
        : enabledRules.filter((r) => r.walletAddress === null);
    return applicable.some((r) => r.includeFailed);
  }

  private scheduleDirectWorkers(): void {
    while (this.activeDirectWorkers < this.directWorkerConcurrency) {
      const nextIdx = this.directQueue.findIndex(
        (item) => !this.directInFlightWallets.has(item.event.wallet),
      );
      if (nextIdx < 0) break;

      const [nextItem] = this.directQueue.splice(nextIdx, 1);
      if (!nextItem) break;
      if (nextItem.signal?.aborted) {
        this.checkDrainComplete();
        continue;
      }

      this.activeDirectWorkers += 1;
      const done = this.processDirectEvent(nextItem.event, nextItem.signal)
        .catch((err: unknown) => {
          this.logger.error(
            { wallet: nextItem.event.wallet, signature: nextItem.event.signature, err },
            "Async webhook event processing failed",
          );
        })
        .finally(() => {
          if (this.directInFlightWallets.get(nextItem.event.wallet) === done) {
            this.directInFlightWallets.delete(nextItem.event.wallet);
          }
          this.activeDirectWorkers -= 1;
          this.scheduleDirectWorkers();
          this.checkDrainComplete();
        });

      this.directInFlightWallets.set(nextItem.event.wallet, done);
    }
    this.checkDrainComplete();
  }

  private checkDrainComplete(): void {
    if (this.directQueue.length === 0 && this.directInFlightWallets.size === 0) {
      for (const waiter of this.drainWaiters.splice(0)) {
        waiter();
      }
    }
  }

  private async enrichSafe(
    event: OnChainEvent,
    signal?: AbortSignal,
  ): Promise<{ readonly event: OnChainEvent; readonly estimatedUsd: number | null }> {
    if (!this.tokenEnricher) {
      return { event, estimatedUsd: null };
    }
    try {
      return await this.tokenEnricher.enrichEvent(event, signal);
    } catch (err) {
      this.logger.debug({ err }, "Token enrichment failed; continuing with raw event");
      return { event, estimatedUsd: null };
    }
  }

  private async applyDedupeRulesAndDispatch(
    event: OnChainEvent,
    advanceRpcCursor: boolean,
    signal?: AbortSignal,
    source: NonNullable<AlertEnvelope["source"]> = "websocket",
  ): Promise<ProcessOutcome> {
    const claim = this.store.claimSignatureAndAdvanceCursor({
      wallet: event.wallet,
      signature: event.signature,
      slot: event.slot,
      eventKind: event.kind,
      advanceRpcCursor,
    });

    if (claim.status === "unwatched") {
      this.filteredTotal += 1;
      return { status: "filtered", reason: "wallet_unwatched" };
    }
    if (claim.status === "paused") {
      this.filteredTotal += 1;
      return { status: "filtered", reason: "wallet_paused" };
    }
    if (claim.status === "deduped") {
      this.dedupedTotal += 1;
      this.emitStreamEvent({
        kind: "tx_deduped",
        timestampIso: new Date(this.nowMs()).toISOString(),
        wallet: event.wallet,
        signature: event.signature,
      });
      return { status: "deduped" };
    }
    if (!claim.walletEnabled) {
      this.filteredTotal += 1;
      return { status: "filtered", reason: "wallet_paused" };
    }

    const { event: enrichedEvent, estimatedUsd } = await this.enrichSafe(event, signal);
    const rules = this.store.listRulesForWallet(enrichedEvent.wallet);
    const evaluationTimeMs = this.nowMs();
    const verdict = evaluateAlertRules(
      enrichedEvent,
      rules,
      this.cooldownStore,
      evaluationTimeMs,
      estimatedUsd,
    );
    const eventMint =
      enrichedEvent.kind === "spl_transfer"
        ? enrichedEvent.mint
        : enrichedEvent.kind === "dex_swap"
          ? enrichedEvent.tokenOut.mint !== WSOL_MINT
            ? enrichedEvent.tokenOut.mint
            : enrichedEvent.tokenIn.mint
          : undefined;

    if (!verdict.matched) {
      this.filteredTotal += 1;
      this.emitStreamEvent({
        kind: "tx_filtered",
        timestampIso: new Date(evaluationTimeMs).toISOString(),
        wallet: enrichedEvent.wallet,
        walletLabel: claim.walletLabel,
        signature: enrichedEvent.signature,
        eventKind: enrichedEvent.kind,
        reason: verdict.reason,
        summary: summarizeEvent(enrichedEvent, estimatedUsd),
        ...(eventMint !== undefined ? { mint: eventMint } : {}),
      });
      this.logger.debug(
        {
          wallet: enrichedEvent.wallet,
          signature: enrichedEvent.signature,
          reason: verdict.reason,
        },
        "Transaction filtered by alert rules",
      );
      return { status: "filtered", reason: verdict.reason };
    }

    const { deliveryId, results } = await this.dispatcher.dispatchTracked(
      enrichedEvent,
      claim.walletLabel,
      signal,
      { estimatedUsd, source },
    );

    const sentCount = results.filter((r) => r.status === "sent").length;
    const failedResults = results.filter((r) => r.status === "failed");

    this.deliverySucceededTotal += sentCount;
    this.deliveryFailedTotal += failedResults.length;

    if (sentCount > 0) {
      this.dispatchedTotal += 1;
      this.cooldownStore.record(
        enrichedEvent.wallet,
        enrichedEvent.kind,
        evaluationTimeMs,
        verdict.matchedRuleId,
      );
    }

    this.emitStreamEvent({
      kind: "tx_dispatched",
      timestampIso: new Date(this.nowMs()).toISOString(),
      deliveryId,
      wallet: enrichedEvent.wallet,
      walletLabel: claim.walletLabel,
      signature: enrichedEvent.signature,
      eventKind: enrichedEvent.kind,
      summary: summarizeEvent(enrichedEvent, estimatedUsd),
      estimatedUsd,
      explorerUrl: solscanTxUrl(enrichedEvent.signature, "mainnet-beta"),
      ...(eventMint !== undefined ? { mint: eventMint } : {}),
      results,
      source,
    });

    if (failedResults.length > 0) {
      this.store.enqueueOutboxItems(
        failedResults.map((failed) => ({
          deliveryId,
          walletAddress: enrichedEvent.wallet,
          walletLabel: claim.walletLabel,
          signature: enrichedEvent.signature,
          event: enrichedEvent,
          channel: failed.channel,
          nextRetryAtMs: this.nowMs() + 15_000,
          lastError: failed.errorMessage ?? "Delivery failed",
        })),
      );
    }

    return { status: "dispatched", results };
  }
}
