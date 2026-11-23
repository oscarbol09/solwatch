import { createHmac } from "node:crypto";
import { formatWebhookPayload } from "./format.js";
import { type AlertEnvelope, type Notifier, postJsonWithRetry } from "./types.js";

export type WebhookNotifierOptions = {
  readonly url: string;
  readonly secret?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

export class WebhookNotifier implements Notifier {
  readonly channel = "webhook";
  private readonly options: WebhookNotifierOptions;

  constructor(options: WebhookNotifierOptions) {
    this.options = options;
  }

  async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify(formatWebhookPayload(envelope));
    const headers: Record<string, string> = {
      "X-Solwatch-Delivery": envelope.deliveryId,
      "X-Solwatch-Event": envelope.event.kind,
    };

    if (this.options.secret) {
      const digest = createHmac("sha256", this.options.secret).update(body).digest("hex");
      headers["X-Solwatch-Signature"] = `sha256=${digest}`;
    }

    await postJsonWithRetry({
      channel: this.channel,
      url: this.options.url,
      body,
      headers,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
      rng: this.options.rng,
      signal,
    });
  }
}
