import {
  abortableSleep,
  computeBackoffDelayMs,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
} from "../domain/backoff.js";
import { NotifierError } from "../domain/errors.js";
import type { OnChainEvent, SolanaCluster } from "../domain/types.js";

export type AlertEnvelope = {
  readonly deliveryId: string;
  readonly cluster: SolanaCluster;
  readonly walletLabel: string | null;
  readonly event: OnChainEvent;
  readonly summary: string;
  readonly explorerUrl: string;
};

export type DeliveryResult = {
  readonly channel: string;
  readonly status: "sent" | "failed";
  readonly errorMessage?: string | undefined;
};

export interface Notifier {
  readonly channel: string;
  send(envelope: AlertEnvelope, signal?: AbortSignal): Promise<void>;
}

export type HttpRetryConfig = {
  readonly channel: string;
  readonly url: string;
  readonly body: string;
  readonly headers?: Record<string, string> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
};

function extractTelegramRetryAfterMs(rawBody: string): number | null {
  try {
    const parsed = JSON.parse(rawBody) as { parameters?: { retry_after?: unknown } };
    const retryAfterSec = parsed?.parameters?.retry_after;
    if (typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(retryAfterSec * 1_000));
    }
  } catch {
    return null;
  }
  return null;
}

export async function postJsonWithRetry(config: HttpRetryConfig): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const maxRetries = config.maxRetries ?? 2;
  const baseBackoffMs = config.baseBackoffMs ?? 400;
  const maxBackoffMs = config.maxBackoffMs ?? 8_000;
  const sleep = config.sleep ?? abortableSleep;
  const rng = config.rng ?? Math.random;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (config.signal?.aborted) {
      throw new NotifierError(config.channel, "Alert delivery aborted", {
        retryable: false,
        cause: config.signal.reason,
      });
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = config.signal
      ? AbortSignal.any([config.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        body: config.body,
        signal: requestSignal,
      });

      if (response.ok) {
        return;
      }

      const bodyText = await response.text().catch(() => "");
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get("retry-after")) ??
        (response.status === 429 ? extractTelegramRetryAfterMs(bodyText) : null);
      const retryable = response.status === 429 || response.status >= 500;

      if (retryable && attempt < maxRetries) {
        const delayMs =
          retryAfterMs ??
          computeBackoffDelayMs(attempt, { baseMs: baseBackoffMs, maxMs: maxBackoffMs }, rng);
        await sleep(delayMs, config.signal);
        continue;
      }

      throw new NotifierError(
        config.channel,
        `${config.channel} delivery failed with HTTP ${response.status}`,
        {
          retryable,
          statusCode: response.status,
          retryAfterMs: retryAfterMs ?? undefined,
        },
      );
    } catch (err) {
      if (err instanceof NotifierError) {
        throw err;
      }
      if (config.signal?.aborted) {
        throw new NotifierError(config.channel, "Alert delivery aborted", {
          retryable: false,
          cause: err,
        });
      }
      if (attempt < maxRetries) {
        const delayMs = computeBackoffDelayMs(
          attempt,
          { baseMs: baseBackoffMs, maxMs: maxBackoffMs },
          rng,
        );
        await sleep(delayMs, config.signal);
        continue;
      }
      throw new NotifierError(
        config.channel,
        `${config.channel} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          retryable: true,
          cause: err,
        },
      );
    }
  }
}
