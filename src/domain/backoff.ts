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
