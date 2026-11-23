import { z } from "zod";
import { ValidationError } from "./domain/errors.js";
import { parseSolToLamports } from "./domain/tokens.js";
import type { CommitmentLevel, SolanaCluster } from "./domain/types.js";

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
        message: `Expected boolean string (true/false), received "${raw}"`,
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

function optionalUrl() {
  return z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      if (raw === undefined || raw.trim() === "") {
        return undefined;
      }
      const result = z.url().safeParse(raw.trim());
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid URL "${raw}"`,
        });
        return z.NEVER;
      }
      return result.data;
    });
}

const RawEnvSchema = z.object({
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]).default("mainnet-beta"),
  SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.url().default("wss://api.mainnet-beta.solana.com"),
  SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/solwatch.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  API_TOKEN: optionalNonEmptyString(),
  HELIUS_WEBHOOK_SECRET: optionalNonEmptyString(),
  CONSOLE_ALERTS_ENABLED: envBoolean(true),
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString(),
  TELEGRAM_ALERT_CHAT_ID: optionalNonEmptyString(),
  TELEGRAM_ALLOWED_CHAT_IDS: optionalNonEmptyString(),
  TELEGRAM_INTERACTIVE_ENABLED: envBoolean(false),
  DISCORD_WEBHOOK_URL: optionalUrl(),
  WEBHOOK_URL: optionalUrl(),
  WEBHOOK_SECRET: optionalNonEmptyString(),
  MIN_SOL_ALERT: z.string().trim().default("0.1"),
  DEFAULT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86_400).default(0),
  INCLUDE_FAILED_TX: envBoolean(false),
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
  readonly consoleAlertsEnabled: boolean;
  readonly telegramBotToken: string | undefined;
  readonly telegramAlertChatId: string | undefined;
  readonly telegramAllowedChatIds: readonly string[];
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
  if (data.TELEGRAM_INTERACTIVE_ENABLED && !data.TELEGRAM_BOT_TOKEN) {
    throw new ValidationError(
      "TELEGRAM_BOT_TOKEN is required when TELEGRAM_INTERACTIVE_ENABLED is true",
      { field: "TELEGRAM_BOT_TOKEN" },
    );
  }

  const minSolAlertLamports = parseSolToLamports(data.MIN_SOL_ALERT);
  const telegramAllowedChatIds = data.TELEGRAM_ALLOWED_CHAT_IDS
    ? data.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : [];

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
    consoleAlertsEnabled: data.CONSOLE_ALERTS_ENABLED,
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramAlertChatId: data.TELEGRAM_ALERT_CHAT_ID,
    telegramAllowedChatIds,
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

const SECRET_QUERY_KEYS = new Set(["api-key", "apikey", "key", "token", "secret"]);

export function redactUrlSecrets(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const [key] of parsed.searchParams.entries()) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
