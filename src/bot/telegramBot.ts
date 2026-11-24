import { Bot, type BotConfig, type Context } from "grammy";
import { ConflictError, LimitExceededError } from "../domain/errors.js";
import { shortAddress } from "../domain/tokens.js";
import { type SolanaCluster, tryParseWalletAddress } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import type { MonitorService } from "../service/monitorService.js";
import type { SqliteStore } from "../store/sqliteStore.js";

const UNAUTHORIZED_LOG_COOLDOWN_MS = 60_000;
const MAX_UNAUTHORIZED_LOG_KEYS = 500;
const MAX_TELEGRAM_REPLY_CHARS = 3_800;

export type TelegramBotOptions = {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowedUserIds?: readonly string[] | undefined;
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

function formatBoundedLines(
  header: string,
  lines: readonly string[],
  maxChars: number = MAX_TELEGRAM_REPLY_CHARS,
): string {
  const collected: string[] = [header];
  let currentLen = header.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const safeLine = line.length > 300 ? `${line.slice(0, 297)}...` : line;
    const suffixReserve = i < lines.length - 1 ? 28 : 0;
    if (currentLen + 1 + safeLine.length + suffixReserve > maxChars) {
      collected.push(`...and ${lines.length - i} more`);
      break;
    }
    collected.push(safeLine);
    currentLen += 1 + safeLine.length;
  }

  return collected.join("\n");
}

export function createTelegramBot(options: TelegramBotOptions): Bot {
  const bot = new Bot(options.botToken, options.botInfo ? { botInfo: options.botInfo } : undefined);
  const allowedChatSet = new Set(options.allowedChatIds);
  const allowedUserSet = new Set(options.allowedUserIds ?? []);
  const unauthorizedLogAt = new Map<string, number>();

  function logUnauthorizedAttempt(key: string, contextInfo: Record<string, unknown>): void {
    const now = Date.now();
    const lastLogged = unauthorizedLogAt.get(key);
    if (lastLogged !== undefined && now - lastLogged < UNAUTHORIZED_LOG_COOLDOWN_MS) {
      return;
    }
    if (unauthorizedLogAt.size >= MAX_UNAUTHORIZED_LOG_KEYS) {
      const oldestKey = unauthorizedLogAt.keys().next().value;
      if (oldestKey !== undefined) {
        unauthorizedLogAt.delete(oldestKey);
      }
    }
    unauthorizedLogAt.set(key, now);
    options.logger.warn(contextInfo, "Dropped unauthorized Telegram update");
  }

  function canMutateWatchlist(ctx: Context): boolean {
    if (!ctx.from || !ctx.chat) return false;
    if (allowedUserSet.size > 0) {
      return allowedUserSet.has(String(ctx.from.id));
    }
    return ctx.chat.type === "private" && String(ctx.chat.id) === String(ctx.from.id);
  }

  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) {
      logUnauthorizedAttempt(`bot:${String(ctx.chat?.id ?? "unknown")}`, {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        isBot: ctx.from?.is_bot ?? null,
      });
      return;
    }

    const chatId = ctx.chat?.id;
    if (allowedChatSet.size === 0 || chatId === undefined || !allowedChatSet.has(String(chatId))) {
      logUnauthorizedAttempt(`chat:${String(chatId ?? "unknown")}`, {
        chatId: chatId ?? null,
        userId: ctx.from.id,
      });
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
    if (!canMutateWatchlist(ctx)) {
      options.logger.warn(
        { chatId: ctx.chat?.id, userId: ctx.from?.id },
        "Rejected unauthorized Telegram /watch attempt",
      );
      await ctx.reply("Permission denied.");
      return;
    }

    const rawArgs = ctx.match.trim();
    if (!rawArgs) {
      await ctx.reply("Usage: /watch <solana_address> [optional label]");
      return;
    }

    const parts = rawArgs.split(/\s+/);
    const rawAddr = parts[0] ?? "";
    const parsedAddress = tryParseWalletAddress(rawAddr);
    if (parsedAddress === null) {
      await ctx.reply(`Invalid Solana wallet address: ${sanitizeControlChars(rawAddr, 48)}`);
      return;
    }

    const label = sanitizeControlChars(parts.slice(1).join(" "), 80) || null;
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
      if (err instanceof LimitExceededError) {
        await ctx.reply("Wallet limit reached. Remove a tracked wallet before adding another.");
        return;
      }
      throw err;
    }
  });

  bot.command("unwatch", async (ctx) => {
    if (!canMutateWatchlist(ctx)) {
      options.logger.warn(
        { chatId: ctx.chat?.id, userId: ctx.from?.id },
        "Rejected unauthorized Telegram /unwatch attempt",
      );
      await ctx.reply("Permission denied.");
      return;
    }

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
      const safeLabel = w.label ? sanitizeControlChars(w.label, 80) : "";
      const labelPart = safeLabel ? `${safeLabel} — ` : "";
      const state = w.enabled ? "active" : "paused";
      return `${idx + 1}. ${labelPart}${shortAddress(w.address)} (${state})`;
    });
    await ctx.reply(formatBoundedLines(`Tracked wallets (${wallets.length}):`, lines));
  });

  bot.command("recent", async (ctx) => {
    const recent = options.store.listRecentAlerts(5);
    if (recent.length === 0) {
      await ctx.reply("No alert deliveries recorded yet.");
      return;
    }
    const lines = recent.map(
      (a) =>
        `[${sanitizeControlChars(a.status, 16)}] ${shortAddress(a.walletAddress)} via ${sanitizeControlChars(a.channel, 24)}: ${sanitizeControlChars(a.summary, 200)}`,
    );
    await ctx.reply(formatBoundedLines("Recent alerts:", lines));
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
