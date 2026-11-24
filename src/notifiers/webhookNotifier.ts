import { createHmac, timingSafeEqual } from "node:crypto";
import {
  assertResolvedHostPublic,
  type LookupAllFn,
  validateOutboundUrl,
} from "../security/ssrf.js";
import { formatWebhookPayload } from "./format.js";
import { type AlertEnvelope, type Notifier, postJsonWithRetry } from "./types.js";

export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

export type WebhookNotifierOptions = {
  readonly url: string;
  readonly secret?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly resolveHost?: LookupAllFn | undefined;
  readonly nowSec?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

export function buildWebhookSignaturePayload(
  timestampSec: string,
  deliveryId: string,
  eventKind: string,
  rawBody: string,
): string {
  return `${timestampSec}.${deliveryId}.${eventKind}.${rawBody}`;
}

export function signWebhookPayload(params: {
  readonly timestampSec: string;
  readonly deliveryId: string;
  readonly eventKind: string;
  readonly rawBody: string;
  readonly secret: string;
}): string {
  const signedPayload = buildWebhookSignaturePayload(
    params.timestampSec,
    params.deliveryId,
    params.eventKind,
    params.rawBody,
  );
  const digest = createHmac("sha256", params.secret).update(signedPayload).digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(params: {
  readonly rawBody: string;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly deliveryId: string;
  readonly eventKind: string;
  readonly secret: string;
  readonly nowSec?: number | undefined;
  readonly toleranceSec?: number | undefined;
}): boolean {
  if (!/^\d{1,12}$/.test(params.timestampHeader)) {
    return false;
  }

  const timestamp = Number(params.timestampHeader);
  if (!Number.isSafeInteger(timestamp)) {
    return false;
  }

  const now = params.nowSec ?? Math.floor(Date.now() / 1_000);
  const tolerance = params.toleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  const expected = signWebhookPayload({
    timestampSec: params.timestampHeader,
    deliveryId: params.deliveryId,
    eventKind: params.eventKind,
    rawBody: params.rawBody,
    secret: params.secret,
  });

  const providedBuf = Buffer.from(params.signatureHeader);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export class WebhookNotifier implements Notifier {
  readonly channel = "webhook";
  private readonly options: WebhookNotifierOptions;
  private readonly parsedUrl: URL;

  constructor(options: WebhookNotifierOptions) {
    this.parsedUrl = validateOutboundUrl(options.url, {
      allowedProtocols: options.allowPrivateHosts ? ["https:", "http:"] : ["https:"],
      allowPrivateHosts: options.allowPrivateHosts ?? false,
      allowCredentials: false,
    });
    this.options = options;
  }

  async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify(formatWebhookPayload(envelope));
    const timestampSec = String(Math.floor((this.options.nowSec ?? (() => Date.now() / 1_000))()));
    const headers: Record<string, string> = {
      "X-Solwatch-Delivery": envelope.deliveryId,
      "X-Solwatch-Event": envelope.event.kind,
      "X-Solwatch-Timestamp": timestampSec,
    };

    if (this.options.secret) {
      headers["X-Solwatch-Signature"] = signWebhookPayload({
        timestampSec,
        deliveryId: envelope.deliveryId,
        eventKind: envelope.event.kind,
        rawBody: body,
        secret: this.options.secret,
      });
    }

    await postJsonWithRetry({
      channel: this.channel,
      url: this.parsedUrl.toString(),
      body,
      headers,
      beforeRequest: this.options.allowPrivateHosts
        ? undefined
        : async () => {
            await assertResolvedHostPublic(this.parsedUrl.hostname, this.options.resolveHost);
          },
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
      rng: this.options.rng,
      signal,
    });
  }
}
