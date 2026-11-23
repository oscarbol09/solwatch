import { formatDiscordEmbed } from "./format.js";
import { type AlertEnvelope, type Notifier, postJsonWithRetry } from "./types.js";

export type DiscordNotifierOptions = {
  readonly webhookUrl: string;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

export class DiscordNotifier implements Notifier {
  readonly channel = "discord";
  private readonly options: DiscordNotifierOptions;

  constructor(options: DiscordNotifierOptions) {
    this.options = options;
  }

  async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
    await postJsonWithRetry({
      channel: this.channel,
      url: this.options.webhookUrl,
      body: JSON.stringify(formatDiscordEmbed(envelope)),
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
      rng: this.options.rng,
      signal,
    });
  }
}
