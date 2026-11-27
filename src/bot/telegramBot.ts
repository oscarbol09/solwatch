import { Bot, type BotConfig, type Context } from "grammy";
import { ConflictError, LimitExceededError, ValidationError } from "../domain/errors.js";
import {
  formatDisplaySol,
  formatUsdValue,
  parseSolToLamports,
  shortAddress,
} from "../domain/tokens.js";
import {
  type SolanaCluster,
  tryParseMintAddress,
  tryParseWalletAddress,
  type WatchedWallet,
} from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { solscanAccountUrl } from "../notifiers/format.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import type { MonitorService } from "../service/monitorService.js";
import type { AlertDeliveryRecord, SqliteStore } from "../store/sqliteStore.js";

const UNAUTHORIZED_LOG_COOLDOWN_MS = 60_000;
const MAX_UNAUTHORIZED_LOG_KEYS = 500;
const MAX_TELEGRAM_REPLY_CHARS = 3_800;

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show welcome help and commands" },
  { command: "help", description: "List available solwatch commands" },
  { command: "watch", description: "Track a Solana wallet: /watch <address> [label]" },
  { command: "unwatch", description: "Stop tracking by address, index, or label" },
  { command: "pause", description: "Pause wallet alerts by address, index, or label" },
  { command: "resume", description: "Resume paused wallet alerts" },
  { command: "list", description: "List tracked wallets with quick actions" },
  { command: "rules", description: "Show configured alert rules" },
  { command: "setmin", description: "Set global min SOL alert threshold" },
  { command: "denylist", description: "Block spam token mint globally" },
  { command: "recent", description: "Show latest alert delivery attempts" },
  { command: "test", description: "Send a synthetic test alert to active channels" },
  { command: "status", description: "Show watcher, channel, and pipeline metrics" },
] as const;

export type TelegramBotOptions = {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowedUserIds?: readonly string[] | undefined;
  readonly service: MonitorService;
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly channels?: readonly string[] | undefined;
  readonly startedAtMs?: number | undefined;
  readonly getStatus: () => {
    readonly running: boolean;
    readonly watchedCount: number;
    readonly reconnectsTotal: number;
  };
  readonly logger: AppLogger;
  readonly botInfo?: BotConfig<Context>["botInfo"];
};

export async function registerTelegramCommands(bot: Bot, logger: AppLogger): Promise<void> {
  try {
    await bot.api.setMyCommands([...TELEGRAM_BOT_COMMANDS]);
  } catch (err) {
    logger.warn({ err }, "Failed registering Telegram bot command menu");
  }
}

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

function resolveWalletTarget(rawTarget: string, store: SqliteStore): WatchedWallet | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;

  const direct = tryParseWalletAddress(trimmed);
  if (direct !== null) {
    return store.getWallet(direct);
  }

  const wallets = store.listWallets();
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    if (index >= 0 && index < wallets.length) {
      return wallets[index] ?? null;
    }
  }

  const lower = trimmed.toLowerCase();
  return wallets.find((w) => w.label?.toLowerCase() === lower) ?? null;
}

export function createTelegramBot(options: TelegramBotOptions): Bot {
  const bot = new Bot(options.botToken, options.botInfo ? { botInfo: options.botInfo } : undefined);
  const allowedChatSet = new Set(options.allowedChatIds);
  const allowedUserSet = new Set(options.allowedUserIds ?? []);
  const unauthorizedLogAt = new Map<string, number>();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const activeChannels = options.channels ?? [];

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
    "/unwatch <address|index|label> - Stop tracking a wallet",
    "/pause <address|index|label> - Pause wallet alerts",
    "/resume <address|index|label> - Resume paused wallet alerts",
    "/list - List tracked wallets with quick actions",
    "/rules - Show active alert rules",
    "/setmin <sol> - Update global min SOL threshold",
    "/denylist <mint> - Block a token mint globally",
    "/recent - Show recent alert deliveries",
    "/test - Dispatch a test alert across active channels",
    "/status - Service, channels & WebSocket status",
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

    const rawTarget = ctx.match.trim();
    if (!rawTarget) {
      await ctx.reply("Usage: /unwatch <solana_address|index|label>");
      return;
    }

    const target = resolveWalletTarget(rawTarget, options.store);
    if (!target) {
      const parsedAddress = tryParseWalletAddress(rawTarget);
      if (parsedAddress !== null) {
        await ctx.reply(`Wallet ${shortAddress(parsedAddress)} was not in your watchlist.`);
        return;
      }
      await ctx.reply("Wallet not found. Usage: /unwatch <solana_address|index|label>");
      return;
    }

    await options.service.removeWallet(target.address);
    await ctx.reply(`Stopped watching ${shortAddress(target.address)}.`);
  });

  async function handlePauseResume(ctx: Context, nextEnabled: boolean): Promise<void> {
    const commandName = nextEnabled ? "resume" : "pause";
    if (!canMutateWatchlist(ctx)) {
      options.logger.warn(
        { chatId: ctx.chat?.id, userId: ctx.from?.id, command: commandName },
        "Rejected unauthorized Telegram wallet state toggle",
      );
      await ctx.reply("Permission denied.");
      return;
    }

    const rawTarget = typeof ctx.match === "string" ? ctx.match.trim() : "";
    if (!rawTarget) {
      await ctx.reply(`Usage: /${commandName} <solana_address|index|label>`);
      return;
    }

    const target = resolveWalletTarget(rawTarget, options.store);
    if (!target) {
      await ctx.reply(`Wallet not found. Usage: /${commandName} <solana_address|index|label>`);
      return;
    }

    await options.service.updateWallet(target.address, { enabled: nextEnabled });
    const verb = nextEnabled ? "Resumed" : "Paused";
    await ctx.reply(`${verb} alerts for ${shortAddress(target.address)}.`);
  }

  bot.command("pause", async (ctx) => {
    await handlePauseResume(ctx, false);
  });

  bot.command("resume", async (ctx) => {
    await handlePauseResume(ctx, true);
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

    const inlineKeyboard = wallets.slice(0, 8).map((w) => [
      {
        text: `${w.enabled ? "Pause" : "Resume"} ${shortAddress(w.address)}`,
        callback_data: `w:t:${w.address}`,
      },
      {
        text: "Remove",
        callback_data: `w:d:${w.address}`,
      },
      {
        text: "Solscan",
        url: solscanAccountUrl(w.address, options.cluster),
      },
    ]);

    await ctx.reply(formatBoundedLines(`Tracked wallets (${wallets.length}):`, lines), {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  });

  bot.command("rules", async (ctx) => {
    const rules = options.store.listAllRules();
    if (rules.length === 0) {
      await ctx.reply("No alert rules configured.");
      return;
    }

    const lines = rules.map((r) => {
      const scope = r.walletAddress ? shortAddress(r.walletAddress) : "global";
      const minSol = `${formatDisplaySol(r.minSolLamports)} SOL`;
      const minUsd =
        r.minUsd !== null && r.minUsd !== undefined ? ` / ${formatUsdValue(r.minUsd)}` : "";
      const state = r.enabled ? "enabled" : "disabled";
      return `${sanitizeControlChars(r.id, 32)} [${scope}] (${state}): >= ${minSol}${minUsd}, cooldown ${r.cooldownSeconds}s, deny ${r.mintDenylist.length}`;
    });
    await ctx.reply(formatBoundedLines(`Alert rules (${rules.length}):`, lines));
  });

  bot.command("setmin", async (ctx) => {
    if (!canMutateWatchlist(ctx)) {
      await ctx.reply("Permission denied.");
      return;
    }

    const rawSol = ctx.match.trim();
    if (!rawSol) {
      await ctx.reply("Usage: /setmin <sol_amount>");
      return;
    }

    try {
      const lamports = parseSolToLamports(rawSol);
      const updated = options.service.updateGlobalMinSol(lamports);
      await ctx.reply(
        `Updated rule ${updated.id} threshold to ${formatDisplaySol(updated.minSolLamports)} SOL.`,
      );
    } catch (err) {
      if (err instanceof ValidationError) {
        await ctx.reply("Invalid SOL amount. Example: /setmin 0.5");
        return;
      }
      throw err;
    }
  });

  bot.command("denylist", async (ctx) => {
    if (!canMutateWatchlist(ctx)) {
      await ctx.reply("Permission denied.");
      return;
    }

    const rawMint = ctx.match.trim();
    const mint = tryParseMintAddress(rawMint);
    if (mint === null) {
      await ctx.reply("Usage: /denylist <spl_token_mint_address>");
      return;
    }

    const updated = options.service.denylistMintGlobal(mint);
    await ctx.reply(
      `Blocked mint ${shortAddress(mint)} on rule ${updated.id} (${updated.mintDenylist.length} denied).`,
    );
  });

  bot.command("recent", async (ctx) => {
    const rows = options.store.listRecentAlerts(20);
    if (rows.length === 0) {
      await ctx.reply("No alert deliveries recorded yet.");
      return;
    }

    const grouped = new Map<string, AlertDeliveryRecord[]>();
    for (const row of rows) {
      if (grouped.size >= 5 && !grouped.has(row.signature)) {
        break;
      }
      const existing = grouped.get(row.signature) ?? [];
      existing.push(row);
      grouped.set(row.signature, existing);
    }

    const lines: string[] = [];
    for (const deliveries of [...grouped.values()].slice(0, 5)) {
      const head = deliveries[0];
      if (!head) continue;
      const channelBadges = deliveries
        .map((d) => `${d.status === "sent" ? "OK" : "FAIL"} ${sanitizeControlChars(d.channel, 16)}`)
        .join(" | ");
      lines.push(
        `[${channelBadges}] ${shortAddress(head.walletAddress)}: ${sanitizeControlChars(head.summary, 180)}`,
      );
    }

    await ctx.reply(formatBoundedLines("Recent alerts:", lines));
  });

  bot.command("test", async (ctx) => {
    if (!canMutateWatchlist(ctx)) {
      await ctx.reply("Permission denied.");
      return;
    }

    const outcome = await options.service.sendTestAlert();
    if (outcome.results.length === 0) {
      await ctx.reply("No outbound alert channels configured.");
      return;
    }
    const summary = outcome.results
      .map((r) => `${r.channel}: ${r.status}${r.errorMessage ? ` (${r.errorMessage})` : ""}`)
      .join(" | ");
    await ctx.reply(`Test alert (${outcome.deliveryId.slice(0, 8)}): ${summary}`);
  });

  bot.command("status", async (ctx) => {
    const watcher = options.getStatus();
    const metrics = options.service.getMetrics();
    const uptimeSec = Math.floor((Date.now() - startedAtMs) / 1_000);
    await ctx.reply(
      [
        `Cluster: ${options.cluster} | Uptime: ${uptimeSec}s`,
        `Watcher running: ${watcher.running} | WS reconnects: ${watcher.reconnectsTotal}`,
        `Watched wallets: ${watcher.watchedCount}`,
        `Active channels: ${activeChannels.length > 0 ? activeChannels.join(", ") : "none"}`,
        `Processed: ${metrics.processedTotal} | Dispatched: ${metrics.dispatchedTotal} | Filtered: ${metrics.filteredTotal} | Deduped: ${metrics.dedupedTotal}`,
        `Outbox pending: ${metrics.outboxPendingCount}`,
      ].join("\n"),
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!canMutateWatchlist(ctx)) {
      await ctx.answerCallbackQuery({ text: "Permission denied.", show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data.startsWith("w:t:")) {
      const address = tryParseWalletAddress(data.slice(4));
      const existing = address ? options.store.getWallet(address) : null;
      if (!address || !existing) {
        await ctx.answerCallbackQuery({ text: "Wallet not found." });
        return;
      }
      const nextEnabled = !existing.enabled;
      await options.service.updateWallet(address, { enabled: nextEnabled });
      await ctx.answerCallbackQuery({
        text: `${nextEnabled ? "Resumed" : "Paused"} ${shortAddress(address)}`,
      });
      await ctx.reply(`${nextEnabled ? "Resumed" : "Paused"} alerts for ${shortAddress(address)}.`);
      return;
    }

    if (data.startsWith("w:d:")) {
      const address = tryParseWalletAddress(data.slice(4));
      if (!address) {
        await ctx.answerCallbackQuery({ text: "Invalid wallet address." });
        return;
      }
      const removed = await options.service.removeWallet(address);
      await ctx.answerCallbackQuery({
        text: removed ? `Removed ${shortAddress(address)}` : "Wallet not found.",
      });
      if (removed) {
        await ctx.reply(`Stopped watching ${shortAddress(address)}.`);
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.catch((botErr) => {
    options.logger.error({ err: botErr.error }, "Telegram bot update handler failed");
  });

  return bot;
}
