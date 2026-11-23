import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AppError, AuthError, NotFoundError, ValidationError } from "../domain/errors.js";
import { parseWalletAddress, type SolanaCluster, type WalletAddress } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import type { MonitorService } from "../service/monitorService.js";
import { parseHeliusWebhookPayload } from "../solana/heliusAdapter.js";
import type { SqliteStore } from "../store/sqliteStore.js";

export type ApiServerOptions = {
  readonly service: MonitorService;
  readonly store: SqliteStore;
  readonly cluster: SolanaCluster;
  readonly apiToken: string | undefined;
  readonly heliusWebhookSecret: string | undefined;
  readonly getWatcherStatus: () => {
    readonly running: boolean;
    readonly watchedCount: number;
    readonly reconnectsTotal: number;
  };
  readonly channels: readonly string[];
  readonly logger: AppLogger;
  readonly startedAtMs?: number | undefined;
};

const CreateWalletBodySchema = z.object({
  address: z.string().min(1),
  label: z.string().trim().min(1).max(80).optional(),
});

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createApiApp(options: ApiServerOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          error: err.code,
          message: err.message,
          details: err.details,
        },
        err.statusCode as 400 | 401 | 404 | 409 | 502,
      );
    }

    if (err instanceof HTTPException) {
      return c.json(
        {
          error: "HTTP_ERROR",
          message: err.message,
        },
        err.status,
      );
    }

    options.logger.error({ err, path: c.req.path }, "Unhandled API error");
    return c.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected server error occurred",
      },
      500,
    );
  });

  app.get("/healthz", (c) => {
    const wallets = options.store.listWallets();
    return c.json({
      status: "ok",
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1_000),
      cluster: options.cluster,
      watchedWallets: wallets.length,
      watcher: options.getWatcherStatus(),
      channels: options.channels,
      metrics: options.service.getMetrics(),
    });
  });

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

  app.get("/api/wallets", (c) => {
    return c.json({ wallets: options.store.listWallets() });
  });

  app.post("/api/wallets", async (c) => {
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
    const wallet = await options.service.addWallet(address, parsedBody.data.label ?? null);
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
    if (options.heliusWebhookSecret !== undefined) {
      const rawAuth = c.req.header("authorization") ?? "";
      const provided = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7).trim() : rawAuth.trim();
      if (!provided || !timingSafeMatch(provided, options.heliusWebhookSecret)) {
        throw new AuthError("Invalid Helius webhook authorization");
      }
    }

    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch (err) {
      throw new ValidationError("Helius webhook body must be valid JSON", undefined, err);
    }

    const watchedSet = new Set(options.store.listWallets(true).map((w) => w.address));
    const events = parseHeliusWebhookPayload(rawPayload, watchedSet);

    let alertsDispatched = 0;
    for (const event of events) {
      const outcome = await options.service.processDirectEvent(event);
      if (outcome.status === "dispatched") {
        alertsDispatched += 1;
      }
    }

    return c.json({
      accepted: events.length,
      alertsDispatched,
    });
  });

  return app;
}
