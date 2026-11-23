import { ValidationError } from "./errors.js";

export type BackoffOptions = {
  readonly baseMs: number;
  readonly maxMs: number;
};

export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions,
  rng: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new ValidationError("Backoff attempt must be a non-negative integer", { attempt });
  }
  if (options.baseMs <= 0 || options.maxMs < options.baseMs) {
    throw new ValidationError("Invalid backoff bounds: require 0 < baseMs <= maxMs", {
      baseMs: options.baseMs,
      maxMs: options.maxMs,
    });
  }

  // Cap shift exponent to avoid Infinity in IEEE-754 before min() clamping.
  const exponent = Math.min(attempt, 30);
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const rawSample = rng();
  const clampedRng = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0.5;
  return Math.floor(ceiling * clampedRng);
}

export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed) * 1_000));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return null;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
