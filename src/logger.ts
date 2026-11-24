import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { sanitizeSecretText } from "./security/sanitize.js";

export type AppLogger = Logger;

const SENSITIVE_FIELD_NAMES = [
  "authorization",
  "apiToken",
  "botToken",
  "telegramBotToken",
  "webhookSecret",
  "heliusWebhookSecret",
  "discordWebhookUrl",
  "webhookUrl",
  "solanaRpcUrl",
  "solanaWsUrl",
  "secret",
  "token",
] as const;

const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "headers.authorization",
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((name) => `*.${name}`),
  ...SENSITIVE_FIELD_NAMES.map((name) => `*.*.${name}`),
];

type SerializedErrorShape = {
  type?: string;
  message: string;
  stack?: string;
  code?: unknown;
  statusCode?: unknown;
  retryable?: unknown;
  cause?: unknown;
};

function serializeError(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth >= 4 || value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return typeof value === "string" ? sanitizeSecretText(value, 500) : value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const out: SerializedErrorShape = {
      type: value.name,
      message: sanitizeSecretText(value.message, 500),
    };
    if (value.stack) {
      out.stack = sanitizeSecretText(value.stack, 1_500);
    }
    const errWithProps = value as Error & {
      code?: unknown;
      statusCode?: unknown;
      retryable?: unknown;
      cause?: unknown;
    };
    if (errWithProps.code !== undefined) {
      out.code = errWithProps.code;
    }
    if (errWithProps.statusCode !== undefined) {
      out.statusCode = errWithProps.statusCode;
    }
    if (errWithProps.retryable !== undefined) {
      out.retryable = errWithProps.retryable;
    }
    if (errWithProps.cause !== undefined) {
      out.cause = serializeError(errWithProps.cause, seen, depth + 1);
    }
    return out;
  }

  return value;
}

export function createLogger(level: string = "info", destination?: DestinationStream): AppLogger {
  const options: LoggerOptions = {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      err: (err: unknown) => serializeError(err),
    },
  };

  return destination ? pino(options, destination) : pino(options);
}
