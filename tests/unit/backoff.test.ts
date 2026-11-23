import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  computeBackoffDelayMs,
  parseRetryAfterMs,
} from "../../src/domain/backoff.js";
import { ValidationError } from "../../src/domain/errors.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("computeBackoffDelayMs", () => {
  it("computes bounded full-jitter delays deterministically with injected rng", () => {
    const opts = { baseMs: 1_000, maxMs: 30_000 };

    expect(computeBackoffDelayMs(0, opts, () => 0)).toBe(0);
    expect(computeBackoffDelayMs(0, opts, () => 0.999999)).toBe(999);
    expect(computeBackoffDelayMs(1, opts, () => 0.5)).toBe(1_000);
    expect(computeBackoffDelayMs(2, opts, () => 0.5)).toBe(2_000);
    // Attempt 5 -> 32_000 capped at maxMs=30_000
    expect(computeBackoffDelayMs(5, opts, () => 0.5)).toBe(15_000);
    expect(computeBackoffDelayMs(50, opts, () => 1)).toBe(30_000);
  });

  it("rejects invalid attempt or timing bounds", () => {
    expect(() => computeBackoffDelayMs(-1, { baseMs: 500, maxMs: 1000 })).toThrow(ValidationError);
    expect(() => computeBackoffDelayMs(0, { baseMs: 0, maxMs: 1000 })).toThrow(ValidationError);
    expect(() => computeBackoffDelayMs(0, { baseMs: 1000, maxMs: 500 })).toThrow(ValidationError);
  });

  it("always returns an integer inside [0, min(maxMs, baseMs * 2^attempt)]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 10, max: 5_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, baseMs, extraMax, rngValue) => {
          const maxMs = baseMs + extraMax;
          const delay = computeBackoffDelayMs(attempt, { baseMs, maxMs }, () => rngValue);
          const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
          return Number.isInteger(delay) && delay >= 0 && delay <= cap;
        },
      ),
    );
  });

  it("parses Retry-After numeric and HTTP-date headers safely", () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("2.5")).toBe(2_500);
    expect(parseRetryAfterMs("not-a-date")).toBeNull();

    const futureDate = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs(futureDate);
    expect(ms).not.toBeNull();
    expect(ms ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("resolves abortableSleep immediately on zero delay or abort signal", async () => {
    vi.useFakeTimers();
    await expect(abortableSleep(0)).resolves.toBeUndefined();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(abortableSleep(10_000, preAborted.signal)).resolves.toBeUndefined();

    const midController = new AbortController();
    const pending = abortableSleep(5_000, midController.signal);
    midController.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
