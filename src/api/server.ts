import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AppError, AuthError, NotFoundError, ValidationError } from "../domain/errors.js";
import { parseWalletAddress, type SolanaCluster, type WalletAddress } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import type { MonitorService } from "../service/monitorService.js";
import { parseHeliusWebhookBatch } from "../solana/heliusAdapter.js";
import type { WatcherStatus } from "../solana/watcher.js";
import type { SqliteStore } from "../store/sqliteStore.js";
import { createRateLimitMiddleware } from "./rateLimit.js";

export type ApiServerOptions = {
  readonly service: MonitorService;
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly apiToken?: string | undefined;
  readonly heliusWebhookSecret?: string | undefined;
  readonly trustProxy?: boolean | undefined;
  readonly rateLimitMax?: number | undefined;
  readonly rateLimitWindowMs?: number | undefined;
  readonly rateLimitKeyGenerator?: ((c: Context) => string) | undefined;
  readonly getWatcherStatus: () => Pick<
    WatcherStatus,
    "running" | "watchedCount" | "reconnectsTotal"
  > &
    Partial<WatcherStatus>;
  readonly channels: readonly string[];
  readonly logger: AppLogger;
  readonly startedAtMs?: number | undefined;
  readonly shutdownSignal?: AbortSignal | undefined;
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const CreateWalletBodySchema = z
  .object({
    address: z.string().min(1),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isJsonMediaType(rawHeader: string | undefined): boolean {
  if (!rawHeader) return false;
  const mediaType = rawHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function jsonErrorResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

export function createApiApp(options: ApiServerOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const rateLimitMax = options.rateLimitMax ?? 120;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;

  app.use("*", async (c, next) => {
    await next();
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(header, value);
    }
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/webhooks/")) {
      c.res.headers.set("Cache-Control", "no-store");
    }
  });

  app.notFound(() => {
    return jsonErrorResponse(404, {
      error: "NOT_FOUND",
      message: "Route not found",
    });
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        options.logger.error({ err, path: c.req.path }, "Upstream API error");
        return jsonErrorResponse(err.statusCode, {
          error: err.code,
          message: "Upstream service error",
        });
      }

      const payload: Record<string, unknown> = {
        error: err.code,
        message: err.message,
      };
      if (err.details !== undefined) {
        payload.details = err.details;
      }
      return jsonErrorResponse(err.statusCode, payload);
    }

    if (err instanceof HTTPException) {
      return jsonErrorResponse(err.status, {
        error: "HTTP_ERROR",
        message: err.message,
      });
    }

    options.logger.error({ err, path: c.req.path }, "Unhandled API error");
    return jsonErrorResponse(500, {
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred",
    });
  });

  const rateLimiter = createRateLimitMiddleware({
    windowMs: rateLimitWindowMs,
    maxRequests: rateLimitMax,
    trustProxy: options.trustProxy ?? false,
    keyGenerator: options.rateLimitKeyGenerator,
    securityHeaders: SECURITY_HEADERS,
  });

  app.use("/healthz", rateLimiter);
  app.use("/api/*", rateLimiter);
  app.use("/webhooks/*", rateLimiter);

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () =>
        jsonErrorResponse(413, {
          error: "PAYLOAD_TOO_LARGE",
          message: "Request body exceeds maximum allowed size",
        }),
    }),
  );

  app.use(
    "/webhooks/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () =>
        jsonErrorResponse(413, {
          error: "PAYLOAD_TOO_LARGE",
          message: "Request body exceeds maximum allowed size",
        }),
    }),
  );

  app.use("/api/*", async (c, next) => {
    if (options.apiToken !== undefined) {
      const authHeader = c.req.header("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!token || !timingSafeMatch(token, options.apiToken)) {
        throw new AuthError("Invalid or missing Bearer token");
      }
    }
    await next();
  });

  app.get("/api/status", (c) => {
    return c.json({
      status: "ok",
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1_000),
      cluster: options.cluster,
      watchedWallets: options.store.countWallets(),
      watcher: options.getWatcherStatus(),
      channels: options.channels,
      metrics: options.service.getMetrics(),
    });
  });

  app.get("/api/wallets", (c) => {
    return c.json({ wallets: options.store.listWallets() });
  });

  app.post("/api/wallets", async (c) => {
    if (!isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(415, {
        error: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err) {
      throw new ValidationError("Request body must be valid JSON", undefined, err);
    }

    const parsedBody = CreateWalletBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      throw new ValidationError("Invalid wallet request payload", {
        issues: parsedBody.error.issues.map((i) => i.message),
      });
    }

    const address = parseWalletAddress(parsedBody.data.address);
    const label =
      parsedBody.data.label !== undefined
        ? sanitizeControlChars(parsedBody.data.label, 80) || null
        : null;
    const wallet = await options.service.addWallet(address, label);
    return c.json({ wallet }, 201);
  });

  app.delete("/api/wallets/:address", async (c) => {
    const address = parseWalletAddress(c.req.param("address"));
    const deleted = await options.service.removeWallet(address);
    if (!deleted) {
      throw new NotFoundError("Wallet", { address });
    }
    return c.json({ deleted: true, address });
  });

  app.get("/api/alerts", (c) => {
    const limitParam = c.req.query("limit");
    const walletParam = c.req.query("wallet");
    let limit = 25;
    if (limitParam !== undefined) {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        throw new ValidationError("Query parameter 'limit' must be an integer between 1 and 200");
      }
      limit = parsedLimit;
    }

    const wallet: WalletAddress | undefined =
      walletParam !== undefined && walletParam.trim().length > 0
        ? parseWalletAddress(walletParam)
        : undefined;

    return c.json({ alerts: options.store.listRecentAlerts(limit, wallet) });
  });

  app.post("/webhooks/helius", async (c) => {
    if (options.heliusWebhookSecret === undefined) {
      return jsonErrorResponse(503, {
        error: "WEBHOOK_DISABLED",
        message: "Helius webhook ingestion requires HELIUS_WEBHOOK_SECRET to be configured",
      });
    }

    const rawAuth = c.req.header("authorization") ?? "";
    const provided = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7).trim() : rawAuth.trim();
    if (!provided || !timingSafeMatch(provided, options.heliusWebhookSecret)) {
      throw new AuthError("Invalid Helius webhook authorization");
    }

    if (!isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(415, {
        error: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
      });
    }

    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch (err) {
      throw new ValidationError("Helius webhook body must be valid JSON", undefined, err);
    }

    const watchedSet = options.service.getEnabledWalletSet();
    const { events, skippedInvalid } = parseHeliusWebhookBatch(rawPayload, watchedSet);
    if (skippedInvalid > 0) {
      options.logger.warn(
        { skippedInvalid, accepted: events.length },
        "Skipped malformed transactions in Helius webhook batch",
      );
    }

    const { queued, dropped } = options.service.enqueueDirectEvents(events, options.shutdownSignal);
    return c.json(
      {
        accepted: events.length,
        queued,
        dropped,
        skippedInvalid,
      },
      202,
    );
  });

  return app;
}
