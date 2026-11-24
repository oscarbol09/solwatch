import type { Context, MiddlewareHandler } from "hono";

export type RateLimitOptions = {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxKeys?: number | undefined;
  readonly trustProxy?: boolean | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly keyGenerator?: ((c: Context) => string) | undefined;
  readonly securityHeaders?: Readonly<Record<string, string>> | undefined;
};

type RateBucket = {
  count: number;
  resetAtMs: number;
};

function defaultClientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
      const firstHop = forwardedFor
        .split(",")
        .map((part) => part.trim())
        .find((part) => part.length > 0);
      if (firstHop) return firstHop;
    }
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  const incomingSocket = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress;
  return incomingSocket?.trim() || "local";
}

function evictExpiredOrOldest(
  buckets: Map<string, RateBucket>,
  now: number,
  maxKeys: number,
): void {
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAtMs <= now) {
      buckets.delete(key);
    }
  }
  while (buckets.size >= maxKeys) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler {
  const windowMs = Math.max(1_000, options.windowMs);
  const maxRequests = Math.max(1, options.maxRequests);
  const maxKeys = Math.max(10, options.maxKeys ?? 10_000);
  const trustProxy = options.trustProxy ?? false;
  const nowMs = options.nowMs ?? Date.now;
  const keyGenerator = options.keyGenerator ?? ((c) => defaultClientKey(c, trustProxy));
  const buckets = new Map<string, RateBucket>();

  return async (c, next) => {
    const now = nowMs();
    const key = keyGenerator(c);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAtMs <= now) {
      if (!bucket && buckets.size >= maxKeys) {
        evictExpiredOrOldest(buckets, now, maxKeys);
      }
      bucket = { count: 0, resetAtMs: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    const resetSec = String(Math.ceil(bucket.resetAtMs / 1_000));

    if (bucket.count > maxRequests) {
      const retryAfterSec = String(Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1_000)));
      const headers: Record<string, string> = {
        ...options.securityHeaders,
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
        "Retry-After": retryAfterSec,
        "X-RateLimit-Limit": String(maxRequests),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": resetSec,
      };
      return new Response(
        JSON.stringify({
          error: "RATE_LIMITED",
          message: "Too many requests",
        }),
        { status: 429, headers },
      );
    }

    await next();
    c.res.headers.set("X-RateLimit-Limit", String(maxRequests));
    c.res.headers.set("X-RateLimit-Remaining", String(remaining));
    c.res.headers.set("X-RateLimit-Reset", resetSec);
    return undefined;
  };
}
