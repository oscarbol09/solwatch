import pino, { type Logger } from "pino";

export type AppLogger = Logger;

export function createLogger(level: string = "info"): AppLogger {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "*.apiToken",
        "*.telegramBotToken",
        "*.webhookSecret",
        "*.heliusWebhookSecret",
        "*.discordWebhookUrl",
      ],
      censor: "[REDACTED]",
    },
  });
}
