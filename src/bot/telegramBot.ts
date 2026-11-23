import { Bot, type BotConfig, type Context } from "grammy";
import { ConflictError } from "../domain/errors.js";
import { shortAddress } from "../domain/tokens.js";
import { type SolanaCluster, tryParseWalletAddress } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { MonitorService } from "../service/monitorService.js";
import type { SqliteStore } from "../store/sqliteStore.js";

export type TelegramBotOptions = {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly service: MonitorService;
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly getStatus: () => {
    readonly running: boolean;
    readonly watchedCount: number;
    readonly reconnectsTotal: number;
  };
  readonly logger: AppLogger;
  readonly botInfo?: BotConfig<Context>["botInfo"];
};

export function createTelegramBot(options: TelegramBotOptions): Bot {
  const bot = new Bot(options.botToken, options.botInfo ? { botInfo: options.botInfo } : undefined);
  const allowedSet = new Set(options.allowedChatIds);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (allowedSet.size === 0 || chatId === undefined || !allowedSet.has(String(chatId))) {
      if (ctx.chat) {
        await ctx.reply("Unauthorized chat. Add your chat ID to TELEGRAM_ALLOWED_CHAT_IDS.");
      }
      return;
    }
    await next();
  });

  const helpText = [
    "solwatch commands:",
    "/watch <address> [label] - Start tracking a Solana wallet",
    "/unwatch <address> - Stop tracking a wallet",
    "/list - List tracked wallets",
    "/recent - Show recent alert deliveries",
    "/status - Service & WebSocket watcher status",
  ].join("\n");

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText);
  });

  bot.command("watch", async (ctx) => {
    const rawArgs = ctx.match.trim();
    if (!rawArgs) {
      await ctx.reply("Usage: /watch <solana_address> [optional label]");
      return;
    }

    const parts = rawArgs.split(/\s+/);
    const rawAddr = parts[0] ?? "";
    const parsedAddress = tryParseWalletAddress(rawAddr);
    if (parsedAddress === null) {
      await ctx.reply(`Invalid Solana wallet address: ${rawAddr}`);
      return;
    }

    const label = parts.slice(1).join(" ").trim() || null;
    try {
      await options.service.addWallet(parsedAddress, label);
      const display = label
        ? `${label} (${shortAddress(parsedAddress)})`
        : shortAddress(parsedAddress);
      await ctx.reply(`Now watching ${display} on ${options.cluster}.`);
    } catch (err) {
      if (err instanceof ConflictError) {
        await ctx.reply(`Wallet ${shortAddress(parsedAddress)} is already watched.`);
        return;
      }
      throw err;
    }
  });

  bot.command("unwatch", async (ctx) => {
    const rawAddr = ctx.match.trim();
    const parsedAddress = tryParseWalletAddress(rawAddr);
    if (parsedAddress === null) {
      await ctx.reply("Usage: /unwatch <solana_address>");
      return;
    }

    const removed = await options.service.removeWallet(parsedAddress);
    if (!removed) {
      await ctx.reply(`Wallet ${shortAddress(parsedAddress)} was not in your watchlist.`);
      return;
    }
    await ctx.reply(`Stopped watching ${shortAddress(parsedAddress)}.`);
  });

  bot.command("list", async (ctx) => {
    const wallets = options.store.listWallets();
    if (wallets.length === 0) {
      await ctx.reply("No wallets tracked yet. Add one with /watch <address> [label].");
      return;
    }
    const lines = wallets.map((w, idx) => {
      const labelPart = w.label ? `${w.label} — ` : "";
      const state = w.enabled ? "active" : "paused";
      return `${idx + 1}. ${labelPart}${shortAddress(w.address)} (${state})`;
    });
    await ctx.reply(`Tracked wallets (${wallets.length}):\n${lines.join("\n")}`);
  });

  bot.command("recent", async (ctx) => {
    const recent = options.store.listRecentAlerts(5);
    if (recent.length === 0) {
      await ctx.reply("No alert deliveries recorded yet.");
      return;
    }
    const lines = recent.map(
      (a) => `[${a.status}] ${shortAddress(a.walletAddress)} via ${a.channel}: ${a.summary}`,
    );
    await ctx.reply(`Recent alerts:\n${lines.join("\n")}`);
  });

  bot.command("status", async (ctx) => {
    const watcher = options.getStatus();
    const metrics = options.service.getMetrics();
    await ctx.reply(
      [
        `Cluster: ${options.cluster}`,
        `Watcher running: ${watcher.running}`,
        `Watched wallets: ${watcher.watchedCount}`,
        `WS reconnects: ${watcher.reconnectsTotal}`,
        `Processed: ${metrics.processedTotal} | Dispatched: ${metrics.dispatchedTotal} | Deduped: ${metrics.dedupedTotal}`,
      ].join("\n"),
    );
  });

  bot.catch((botErr) => {
    options.logger.error({ err: botErr.error }, "Telegram bot update handler failed");
  });

  return bot;
}
