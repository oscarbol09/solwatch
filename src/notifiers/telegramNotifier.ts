import { formatTelegramHtml } from "./format.js";
import { type AlertEnvelope, type Notifier, postJsonWithRetry } from "./types.js";

export type TelegramNotifierOptions = {
  readonly botToken: string;
  readonly chatId: string;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

export class TelegramNotifier implements Notifier {
  readonly channel = "telegram";
  private readonly options: TelegramNotifierOptions;

  constructor(options: TelegramNotifierOptions) {
    this.options = options;
  }

  async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;
    const payload = {
      chat_id: this.options.chatId,
      text: formatTelegramHtml(envelope),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: "View on Solscan", url: envelope.explorerUrl }]],
      },
    };

    await postJsonWithRetry({
      channel: this.channel,
      url: endpoint,
      body: JSON.stringify(payload),
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      sleep: this.options.sleep,
      rng: this.options.rng,
      signal,
    });
  }
}
