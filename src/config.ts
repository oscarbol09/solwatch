import { z } from "zod";
import { ValidationError } from "./domain/errors.js";
import { parseSolToLamports } from "./domain/tokens.js";
import type { CommitmentLevel, SolanaCluster } from "./domain/types.js";
import { isLoopbackHost, validateDiscordWebhookUrl, validateOutboundUrl } from "./security/ssrf.js";

export { redactUrlSecrets } from "./security/sanitize.js";

const MIN_SECRET_LENGTH = 32;
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,20}$/;
const TELEGRAM_USER_ID_RE = /^\d{1,20}$/;
const TELEGRAM_TOKEN_UNSAFE_RE = /[\s/?#@]/;

function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): boolean => {
      if (raw === undefined || raw.trim() === "") {
        return defaultValue;
      }
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no") {
        return false;
      }
      ctx.addIssue({
        code: "custom",
        message: "Expected boolean string (true/false/1/0/yes/no)",
      });
      return z.NEVER;
    });
}

function optionalNonEmptyString() {
  return z
    .string()
    .optional()
    .transform((raw): string | undefined => {
      if (raw === undefined) return undefined;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    });
}

function optionalSecret(minLength: number) {
  return optionalNonEmptyString().superRefine((val, ctx) => {
    if (val !== undefined && val.length < minLength) {
      ctx.addIssue({
        code: "custom",
        message: `Secret must be at least ${minLength} characters when configured`,
      });
    }
  });
}

function parseCommaSeparatedIds(
  raw: string | undefined,
  pattern: RegExp,
  fieldName: string,
): readonly string[] {
  if (!raw) return [];
  const items = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  for (const item of items) {
    if (!pattern.test(item)) {
      throw new ValidationError(`Invalid ID entry in ${fieldName}`, { field: fieldName });
    }
  }
  return items;
}

const RawEnvSchema = z.object({
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]).default("mainnet-beta"),
  SOLANA_RPC_URL: z.string().trim().min(1).default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.string().trim().min(1).default("wss://api.mainnet-beta.solana.com"),
  SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/solwatch.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_TOKEN: optionalSecret(MIN_SECRET_LENGTH),
  HELIUS_WEBHOOK_SECRET: optionalSecret(MIN_SECRET_LENGTH),
  ALLOW_UNAUTHENTICATED_API: envBoolean(false),
  ALLOW_PRIVATE_WEBHOOK_URLS: envBoolean(false),
  TRUST_PROXY: envBoolean(false),
  MAX_WATCHED_WALLETS: z.coerce.number().int().min(1).max(10_000).default(100),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(120),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  CONSOLE_ALERTS_ENABLED: envBoolean(true),
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString(),
  TELEGRAM_ALERT_CHAT_ID: optionalNonEmptyString(),
  TELEGRAM_ALLOWED_CHAT_IDS: optionalNonEmptyString(),
  TELEGRAM_ALLOWED_USER_IDS: optionalNonEmptyString(),
  TELEGRAM_INTERACTIVE_ENABLED: envBoolean(false),
  DISCORD_WEBHOOK_URL: optionalNonEmptyString(),
  WEBHOOK_URL: optionalNonEmptyString(),
  WEBHOOK_SECRET: optionalSecret(MIN_SECRET_LENGTH),
  MIN_SOL_ALERT: z.string().trim().default("0.1"),
  DEFAULT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86_400).default(0),
  INCLUDE_FAILED_TX: envBoolean(false),
  DASHBOARD_ENABLED: envBoolean(true),
  PRICE_ENRICHMENT_ENABLED: envBoolean(true),
  MIN_USD_ALERT: optionalNonEmptyString(),
  TELEGRAM_ALERT_THREAD_ID: optionalNonEmptyString(),
  CORS_ORIGIN: optionalNonEmptyString(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = {
  readonly solanaCluster: SolanaCluster;
  readonly solanaRpcUrl: string;
  readonly solanaWsUrl: string;
  readonly solanaCommitment: CommitmentLevel;
  readonly databasePath: string;
  readonly port: number;
  readonly host: string;
  readonly apiToken: string | undefined;
  readonly heliusWebhookSecret: string | undefined;
  readonly allowPrivateWebhookUrls: boolean;
  readonly trustProxy: boolean;
  readonly maxWatchedWallets: number;
  readonly apiRateLimitMax: number;
  readonly apiRateLimitWindowMs: number;
  readonly dashboardEnabled: boolean;
  readonly priceEnrichmentEnabled: boolean;
  readonly minUsdAlert: number | undefined;
  readonly telegramAlertThreadId: number | undefined;
  readonly corsOrigin: string | undefined;
  readonly consoleAlertsEnabled: boolean;
  readonly telegramBotToken: string | undefined;
  readonly telegramAlertChatId: string | undefined;
  readonly telegramAllowedChatIds: readonly string[];
  readonly telegramAllowedUserIds: readonly string[];
  readonly telegramInteractiveEnabled: boolean;
  readonly discordWebhookUrl: string | undefined;
  readonly webhookUrl: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly minSolAlertLamports: bigint;
  readonly defaultCooldownSeconds: number;
  readonly includeFailedTx: boolean;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
};

export function parseEnvConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ValidationError("Invalid environment configuration", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const data = parsed.data;

  try {
    validateOutboundUrl(data.SOLANA_RPC_URL, {
      allowedProtocols: ["https:", "http:"],
      allowPrivateHosts: true,
      allowCredentials: true,
    });
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? `Invalid SOLANA_RPC_URL: ${err.message}` : "Invalid SOLANA_RPC_URL",
      { field: "SOLANA_RPC_URL" },
    );
  }

  try {
    validateOutboundUrl(data.SOLANA_WS_URL, {
      allowedProtocols: ["wss:", "ws:"],
      allowPrivateHosts: true,
      allowCredentials: true,
    });
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? `Invalid SOLANA_WS_URL: ${err.message}` : "Invalid SOLANA_WS_URL",
      { field: "SOLANA_WS_URL" },
    );
  }

  if (data.DISCORD_WEBHOOK_URL !== undefined) {
    try {
      validateDiscordWebhookUrl(data.DISCORD_WEBHOOK_URL);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error
          ? `Invalid DISCORD_WEBHOOK_URL: ${err.message}`
          : "Invalid DISCORD_WEBHOOK_URL",
        { field: "DISCORD_WEBHOOK_URL" },
      );
    }
  }

  if (data.WEBHOOK_URL !== undefined) {
    try {
      validateOutboundUrl(data.WEBHOOK_URL, {
        allowedProtocols: data.ALLOW_PRIVATE_WEBHOOK_URLS ? ["https:", "http:"] : ["https:"],
        allowPrivateHosts: data.ALLOW_PRIVATE_WEBHOOK_URLS,
        allowCredentials: false,
      });
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? `Invalid WEBHOOK_URL: ${err.message}` : "Invalid WEBHOOK_URL",
        { field: "WEBHOOK_URL" },
      );
    }
  }

  if (!isLoopbackHost(data.HOST) && !data.API_TOKEN) {
    const canBypassInDev = data.ALLOW_UNAUTHENTICATED_API && env.NODE_ENV !== "production";
    if (!canBypassInDev) {
      throw new ValidationError("API_TOKEN is required when HOST is bound beyond loopback", {
        field: "API_TOKEN",
      });
    }
  }

  if (
    data.TELEGRAM_BOT_TOKEN !== undefined &&
    TELEGRAM_TOKEN_UNSAFE_RE.test(data.TELEGRAM_BOT_TOKEN)
  ) {
    throw new ValidationError("TELEGRAM_BOT_TOKEN contains forbidden URL control characters", {
      field: "TELEGRAM_BOT_TOKEN",
    });
  }

  if (
    data.TELEGRAM_ALERT_CHAT_ID !== undefined &&
    !TELEGRAM_CHAT_ID_RE.test(data.TELEGRAM_ALERT_CHAT_ID)
  ) {
    throw new ValidationError("TELEGRAM_ALERT_CHAT_ID must be a numeric Telegram chat ID", {
      field: "TELEGRAM_ALERT_CHAT_ID",
    });
  }

  if (data.TELEGRAM_INTERACTIVE_ENABLED && !data.TELEGRAM_BOT_TOKEN) {
    throw new ValidationError(
      "TELEGRAM_BOT_TOKEN is required when TELEGRAM_INTERACTIVE_ENABLED is true",
      { field: "TELEGRAM_BOT_TOKEN" },
    );
  }

  const minSolAlertLamports = parseSolToLamports(data.MIN_SOL_ALERT);
  const telegramAllowedChatIds = parseCommaSeparatedIds(
    data.TELEGRAM_ALLOWED_CHAT_IDS,
    TELEGRAM_CHAT_ID_RE,
    "TELEGRAM_ALLOWED_CHAT_IDS",
  );
  const telegramAllowedUserIds = parseCommaSeparatedIds(
    data.TELEGRAM_ALLOWED_USER_IDS,
    TELEGRAM_USER_ID_RE,
    "TELEGRAM_ALLOWED_USER_IDS",
  );

  if (data.TELEGRAM_INTERACTIVE_ENABLED && telegramAllowedChatIds.length === 0) {
    throw new ValidationError(
      "TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat ID when TELEGRAM_INTERACTIVE_ENABLED is true",
      { field: "TELEGRAM_ALLOWED_CHAT_IDS" },
    );
  }

  if (
    data.TELEGRAM_INTERACTIVE_ENABLED &&
    telegramAllowedChatIds.some((id) => id.startsWith("-")) &&
    telegramAllowedUserIds.length === 0
  ) {
    throw new ValidationError(
      "TELEGRAM_ALLOWED_USER_IDS is required when group chat IDs are listed in TELEGRAM_ALLOWED_CHAT_IDS",
      { field: "TELEGRAM_ALLOWED_USER_IDS" },
    );
  }

  let minUsdAlert: number | undefined;
  if (data.MIN_USD_ALERT !== undefined) {
    const parsedUsd = Number(data.MIN_USD_ALERT);
    if (!Number.isFinite(parsedUsd) || parsedUsd < 0) {
      throw new ValidationError("MIN_USD_ALERT must be a non-negative finite number", {
        field: "MIN_USD_ALERT",
      });
    }
    minUsdAlert = parsedUsd;
  }

  let telegramAlertThreadId: number | undefined;
  if (data.TELEGRAM_ALERT_THREAD_ID !== undefined) {
    if (!/^\d{1,12}$/.test(data.TELEGRAM_ALERT_THREAD_ID)) {
      throw new ValidationError("TELEGRAM_ALERT_THREAD_ID must be a positive integer", {
        field: "TELEGRAM_ALERT_THREAD_ID",
      });
    }
    const parsedThread = Number(data.TELEGRAM_ALERT_THREAD_ID);
    if (!Number.isSafeInteger(parsedThread) || parsedThread <= 0) {
      throw new ValidationError("TELEGRAM_ALERT_THREAD_ID must be a positive integer", {
        field: "TELEGRAM_ALERT_THREAD_ID",
      });
    }
    telegramAlertThreadId = parsedThread;
  }

  let corsOrigin: string | undefined;
  if (data.CORS_ORIGIN !== undefined) {
    try {
      corsOrigin = validateOutboundUrl(data.CORS_ORIGIN, {
        allowedProtocols: ["https:", "http:"],
        allowPrivateHosts: true,
        allowCredentials: false,
      }).origin;
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? `Invalid CORS_ORIGIN: ${err.message}` : "Invalid CORS_ORIGIN",
        { field: "CORS_ORIGIN" },
      );
    }
  }

  return {
    solanaCluster: data.SOLANA_CLUSTER,
    solanaRpcUrl: data.SOLANA_RPC_URL,
    solanaWsUrl: data.SOLANA_WS_URL,
    solanaCommitment: data.SOLANA_COMMITMENT,
    databasePath: data.DATABASE_PATH,
    port: data.PORT,
    host: data.HOST,
    apiToken: data.API_TOKEN,
    heliusWebhookSecret: data.HELIUS_WEBHOOK_SECRET,
    allowPrivateWebhookUrls: data.ALLOW_PRIVATE_WEBHOOK_URLS,
    trustProxy: data.TRUST_PROXY,
    maxWatchedWallets: data.MAX_WATCHED_WALLETS,
    apiRateLimitMax: data.API_RATE_LIMIT_MAX,
    apiRateLimitWindowMs: data.API_RATE_LIMIT_WINDOW_MS,
    dashboardEnabled: data.DASHBOARD_ENABLED,
    priceEnrichmentEnabled: data.PRICE_ENRICHMENT_ENABLED,
    minUsdAlert,
    telegramAlertThreadId,
    corsOrigin,
    consoleAlertsEnabled: data.CONSOLE_ALERTS_ENABLED,
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramAlertChatId: data.TELEGRAM_ALERT_CHAT_ID,
    telegramAllowedChatIds,
    telegramAllowedUserIds,
    telegramInteractiveEnabled: data.TELEGRAM_INTERACTIVE_ENABLED,
    discordWebhookUrl: data.DISCORD_WEBHOOK_URL,
    webhookUrl: data.WEBHOOK_URL,
    webhookSecret: data.WEBHOOK_SECRET,
    minSolAlertLamports,
    defaultCooldownSeconds: data.DEFAULT_COOLDOWN_SECONDS,
    includeFailedTx: data.INCLUDE_FAILED_TX,
    logLevel: data.LOG_LEVEL,
  };
}
