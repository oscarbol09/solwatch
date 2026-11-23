import { randomUUID } from "node:crypto";
import type { OnChainEvent, SolanaCluster } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { SqliteStore } from "../store/sqliteStore.js";
import { buildAlertEnvelope, summarizeEvent } from "./format.js";
import type { DeliveryResult, Notifier } from "./types.js";

export type AlertDispatcherOptions = {
  readonly notifiers: readonly Notifier[];
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly logger: AppLogger;
};

export class AlertDispatcher {
  private readonly notifiers: readonly Notifier[];
  private readonly store: SqliteStore;
  private readonly cluster: SolanaCluster;
  private readonly logger: AppLogger;

  constructor(options: AlertDispatcherOptions) {
    this.notifiers = options.notifiers;
    this.store = options.store;
    this.cluster = options.cluster;
    this.logger = options.logger;
  }

  getChannels(): readonly string[] {
    return this.notifiers.map((n) => n.channel);
  }

  async dispatch(
    event: OnChainEvent,
    walletLabel: string | null,
    signal?: AbortSignal,
  ): Promise<readonly DeliveryResult[]> {
    const summary = summarizeEvent(event);
    if (this.notifiers.length === 0) {
      return [];
    }

    const deliveryId = randomUUID();
    const envelope = buildAlertEnvelope(event, walletLabel, this.cluster, deliveryId);
    const settled = await Promise.allSettled(
      this.notifiers.map(async (notifier) => {
        await notifier.send(envelope, signal);
        return notifier.channel;
      }),
    );

    const results: DeliveryResult[] = [];
    for (let i = 0; i < this.notifiers.length; i += 1) {
      const notifier = this.notifiers[i];
      const outcome = settled[i];
      if (!notifier || !outcome) continue;

      if (outcome.status === "fulfilled") {
        this.store.recordDelivery({
          walletAddress: event.wallet,
          signature: event.signature,
          eventKind: event.kind,
          summary,
          channel: notifier.channel,
          status: "sent",
        });
        results.push({ channel: notifier.channel, status: "sent" });
      } else {
        const errorMessage =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        this.logger.error(
          { channel: notifier.channel, signature: event.signature, err: outcome.reason },
          "Alert delivery failed",
        );
        this.store.recordDelivery({
          walletAddress: event.wallet,
          signature: event.signature,
          eventKind: event.kind,
          summary,
          channel: notifier.channel,
          status: "failed",
          errorMessage,
        });
        results.push({ channel: notifier.channel, status: "failed", errorMessage });
      }
    }

    return results;
  }
}
