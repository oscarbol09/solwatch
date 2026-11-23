import { classifyParsedTransaction } from "../domain/classifier.js";
import { CooldownTracker, evaluateAlertRules } from "../domain/rules.js";
import {
  type AlertRule,
  type OnChainEvent,
  parseRuleId,
  type TxSignature,
  type WalletAddress,
  type WatchedWallet,
} from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { AlertDispatcher } from "../notifiers/dispatcher.js";
import type { DeliveryResult } from "../notifiers/types.js";
import type { SolanaRpcPort } from "../solana/rpcClient.js";
import type { SqliteStore } from "../store/sqliteStore.js";

export interface WalletWatchControl {
  watchWallet(address: WalletAddress): Promise<void>;
  unwatchWallet(address: WalletAddress): Promise<void>;
}

export type ProcessOutcome =
  | { readonly status: "dispatched"; readonly results: readonly DeliveryResult[] }
  | { readonly status: "deduped" }
  | { readonly status: "filtered"; readonly reason: string }
  | { readonly status: "not_found" };

export type ServiceMetrics = {
  readonly processedTotal: number;
  readonly dispatchedTotal: number;
  readonly dedupedTotal: number;
  readonly filteredTotal: number;
  readonly notFoundTotal: number;
};

export type DefaultRuleConfig = {
  readonly minSolLamports: bigint;
  readonly includeFailed: boolean;
  readonly cooldownSeconds: number;
};

export type MonitorServiceOptions = {
  readonly store: SqliteStore;
  readonly rpcPort: SolanaRpcPort;
  readonly dispatcher: AlertDispatcher;
  readonly logger: AppLogger;
  readonly watchControl?: WalletWatchControl | undefined;
  readonly nowMs?: (() => number) | undefined;
};

export class MonitorService {
  private readonly store: SqliteStore;
  private readonly rpcPort: SolanaRpcPort;
  private readonly dispatcher: AlertDispatcher;
  private readonly logger: AppLogger;
  private readonly cooldownTracker = new CooldownTracker();
  private readonly nowMs: () => number;
  private watchControl: WalletWatchControl | undefined;

  private processedTotal = 0;
  private dispatchedTotal = 0;
  private dedupedTotal = 0;
  private filteredTotal = 0;
  private notFoundTotal = 0;

  constructor(options: MonitorServiceOptions) {
    this.store = options.store;
    this.rpcPort = options.rpcPort;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger;
    this.watchControl = options.watchControl;
    this.nowMs = options.nowMs ?? Date.now;
  }

  attachWatchControl(control: WalletWatchControl): void {
    this.watchControl = control;
  }

  ensureDefaultGlobalRule(defaults: DefaultRuleConfig): void {
    if (this.store.listAllRules().length > 0) {
      return;
    }
    const defaultRule: AlertRule = {
      id: parseRuleId("global-default"),
      walletAddress: null,
      minSolLamports: defaults.minSolLamports,
      eventTypes: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"],
      mintAllowlist: [],
      mintDenylist: [],
      includeFailed: defaults.includeFailed,
      cooldownSeconds: defaults.cooldownSeconds,
      enabled: true,
    };
    this.store.upsertRule(defaultRule);
  }

  async addWallet(address: WalletAddress, label: string | null = null): Promise<WatchedWallet> {
    const created = this.store.createWallet(address, label);
    await this.watchControl?.watchWallet(address);
    this.logger.info({ wallet: address, label }, "Wallet added to watchlist");
    return created;
  }

  async removeWallet(address: WalletAddress): Promise<boolean> {
    const removed = this.store.removeWallet(address);
    if (removed) {
      await this.watchControl?.unwatchWallet(address);
      this.logger.info({ wallet: address }, "Wallet removed from watchlist");
    }
    return removed;
  }

  async processSignature(
    wallet: WalletAddress,
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome> {
    this.processedTotal += 1;
    const rawTx = await this.rpcPort.getTransaction(signature, signal);
    if (rawTx === null) {
      this.notFoundTotal += 1;
      this.logger.debug({ wallet, signature }, "Transaction not yet indexed or missing on RPC");
      return { status: "not_found" };
    }

    const event = classifyParsedTransaction(rawTx, wallet);
    const label = this.store.getWallet(wallet)?.label ?? null;
    return this.applyDedupeRulesAndDispatch(event, label, signal);
  }

  async processDirectEvent(event: OnChainEvent, signal?: AbortSignal): Promise<ProcessOutcome> {
    this.processedTotal += 1;
    const label = this.store.getWallet(event.wallet)?.label ?? null;
    return this.applyDedupeRulesAndDispatch(event, label, signal);
  }

  getMetrics(): ServiceMetrics {
    return {
      processedTotal: this.processedTotal,
      dispatchedTotal: this.dispatchedTotal,
      dedupedTotal: this.dedupedTotal,
      filteredTotal: this.filteredTotal,
      notFoundTotal: this.notFoundTotal,
    };
  }

  private async applyDedupeRulesAndDispatch(
    event: OnChainEvent,
    walletLabel: string | null,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome> {
    const inserted = this.store.tryMarkSignatureProcessed(
      event.wallet,
      event.signature,
      event.slot,
      event.kind,
    );
    if (!inserted) {
      this.dedupedTotal += 1;
      return { status: "deduped" };
    }

    // Advance the wallet cursor even when filtered so reconnect backfill skips processed txs.
    this.store.updateLastSignature(event.wallet, event.signature);

    const rules = this.store.listRulesForWallet(event.wallet);
    const evaluationTimeMs = this.nowMs();
    const verdict = evaluateAlertRules(event, rules, this.cooldownTracker, evaluationTimeMs);
    if (!verdict.matched) {
      this.filteredTotal += 1;
      this.logger.debug(
        { wallet: event.wallet, signature: event.signature, reason: verdict.reason },
        "Transaction filtered by alert rules",
      );
      return { status: "filtered", reason: verdict.reason };
    }

    this.cooldownTracker.record(event.wallet, event.kind, evaluationTimeMs);
    const results = await this.dispatcher.dispatch(event, walletLabel, signal);
    this.dispatchedTotal += 1;
    return { status: "dispatched", results };
  }
}
