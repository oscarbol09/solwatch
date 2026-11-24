import { randomUUID } from "node:crypto";
import type { OnChainEvent, SolanaCluster } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { sanitizeSecretText } from "../security/sanitize.js";
import type { NewDeliveryRecord, SqliteStore } from "../store/sqliteStore.js";
import { type BuildAlertEnvelopeOptions, buildAlertEnvelope, summarizeEvent } from "./format.js";
import type { DeliveryResult, Notifier } from "./types.js";

export type AlertDispatcherOptions = {
  readonly notifiers: readonly Notifier[];
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly logger: AppLogger;
};

export type TrackedDispatchResult = {
  readonly deliveryId: string;
  readonly results: readonly DeliveryResult[];
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
    envelopeOptions: BuildAlertEnvelopeOptions = {},
  ): Promise<readonly DeliveryResult[]> {
    const tracked = await this.dispatchTracked(event, walletLabel, signal, envelopeOptions);
    return tracked.results;
  }

  async dispatchTracked(
    event: OnChainEvent,
    walletLabel: string | null,
    signal?: AbortSignal,
    envelopeOptions: BuildAlertEnvelopeOptions = {},
  ): Promise<TrackedDispatchResult> {
    const deliveryId = randomUUID();
    if (this.notifiers.length === 0) {
      return { deliveryId, results: [] };
    }

    const summary = summarizeEvent(event, envelopeOptions.estimatedUsd);
    const envelope = buildAlertEnvelope(
      event,
      walletLabel,
      this.cluster,
      deliveryId,
      envelopeOptions,
    );
    const settled = await Promise.allSettled(
      this.notifiers.map(async (notifier) => {
        await notifier.send(envelope, signal);
        return notifier.channel;
      }),
    );

    const results: DeliveryResult[] = [];
    const deliveryRecords: NewDeliveryRecord[] = [];
    for (let i = 0; i < this.notifiers.length; i += 1) {
      const notifier = this.notifiers[i];
      const outcome = settled[i];
      if (!notifier || !outcome) continue;

      if (outcome.status === "fulfilled") {
        deliveryRecords.push({
          walletAddress: event.wallet,
          signature: event.signature,
          eventKind: event.kind,
          summary,
          channel: notifier.channel,
          status: "sent",
        });
        results.push({ channel: notifier.channel, status: "sent" });
      } else {
        const rawMessage =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        const errorMessage = sanitizeSecretText(rawMessage, 500);
        this.logger.error(
          {
            deliveryId,
            channel: notifier.channel,
            signature: event.signature,
            err: outcome.reason,
          },
          "Alert delivery failed",
        );
        deliveryRecords.push({
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

    this.store.recordDeliveriesBatch(deliveryRecords);
    return { deliveryId, results };
  }

  async dispatchToChannel(
    channelName: string,
    event: OnChainEvent,
    walletLabel: string | null,
    deliveryId: string,
    signal?: AbortSignal,
    envelopeOptions: BuildAlertEnvelopeOptions = {},
  ): Promise<DeliveryResult> {
    const notifier = this.notifiers.find((n) => n.channel === channelName);
    if (!notifier) {
      return {
        channel: channelName,
        status: "failed",
        errorMessage: `Channel "${channelName}" is not configured`,
      };
    }

    const summary = summarizeEvent(event, envelopeOptions.estimatedUsd);
    const envelope = buildAlertEnvelope(
      event,
      walletLabel,
      this.cluster,
      deliveryId,
      envelopeOptions,
    );
    try {
      await notifier.send(envelope, signal);
      this.store.recordDelivery({
        walletAddress: event.wallet,
        signature: event.signature,
        eventKind: event.kind,
        summary,
        channel: channelName,
        status: "sent",
      });
      return { channel: channelName, status: "sent" };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const errorMessage = sanitizeSecretText(rawMessage, 500);
      this.logger.error(
        { deliveryId, channel: channelName, signature: event.signature, err },
        "Outbox alert delivery retry failed",
      );
      this.store.recordDelivery({
        walletAddress: event.wallet,
        signature: event.signature,
        eventKind: event.kind,
        summary,
        channel: channelName,
        status: "failed",
        errorMessage,
      });
      return { channel: channelName, status: "failed", errorMessage };
    }
  }
}
