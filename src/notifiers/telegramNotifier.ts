import { ValidationError } from "../domain/errors.js";
import { WSOL_MINT } from "../domain/tokens.js";
import {
  dexScreenerTokenUrl,
  formatTelegramHtml,
  solscanAccountUrl,
  solscanTokenUrl,
} from "./format.js";
import { type AlertEnvelope, type Notifier, postJsonWithRetry } from "./types.js";

const UNSAFE_BOT_TOKEN_RE = /[\s/?#@]/;

export type TelegramNotifierOptions = {
  readonly botToken: string;
  readonly chatId: string;
  readonly messageThreadId?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

type InlineButton = { readonly text: string; readonly url: string };

function buildAlertKeyboard(envelope: AlertEnvelope): readonly (readonly InlineButton[])[] {
  const rows: InlineButton[][] = [
    [
      { text: "View on Solscan", url: envelope.explorerUrl },
      { text: "Wallet", url: solscanAccountUrl(envelope.event.wallet, envelope.cluster) },
    ],
  ];

  const ev = envelope.event;
  if (ev.kind === "spl_transfer") {
    rows.push([
      { text: "Token", url: solscanTokenUrl(ev.mint, envelope.cluster) },
      { text: "DexScreener", url: dexScreenerTokenUrl(ev.mint) },
    ]);
  } else if (ev.kind === "dex_swap") {
    const primaryMint = ev.tokenOut.mint !== WSOL_MINT ? ev.tokenOut.mint : ev.tokenIn.mint;
    rows.push([
      { text: "Token", url: solscanTokenUrl(primaryMint, envelope.cluster) },
      { text: "DexScreener", url: dexScreenerTokenUrl(primaryMint) },
    ]);
  }

  return rows;
}

export class TelegramNotifier implements Notifier {
  readonly channel = "telegram";
  private readonly options: TelegramNotifierOptions;

  constructor(options: TelegramNotifierOptions) {
    const trimmedToken = options.botToken.trim();
    if (trimmedToken.length === 0 || UNSAFE_BOT_TOKEN_RE.test(trimmedToken)) {
      throw new ValidationError("Invalid Telegram bot token format", { field: "botToken" });
    }
    this.options = {
      ...options,
      botToken: trimmedToken,
    };
  }

  async send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: this.options.chatId,
      text: formatTelegramHtml(envelope),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: buildAlertKeyboard(envelope),
      },
    };
    if (this.options.messageThreadId !== undefined) {
      payload.message_thread_id = this.options.messageThreadId;
    }

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
