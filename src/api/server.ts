import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AppError, AuthError, NotFoundError, ValidationError } from "../domain/errors.js";
import { parseSolToLamports } from "../domain/tokens.js";
import {
  type AlertRule,
  parseMintAddress,
  parseRuleId,
  parseWalletAddress,
  type SolanaCluster,
  type WalletAddress,
  type WatchedWallet,
} from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { MetricsCollector } from "../observability/metrics.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import type { MonitorService } from "../service/monitorService.js";
import { parseHeliusWebhookBatch } from "../solana/heliusAdapter.js";
import type { WatcherStatus } from "../solana/watcher.js";
import type { SqliteStore } from "../store/sqliteStore.js";
import { renderDashboardHtml } from "./dashboard.js";
import { buildOpenApiSpec, renderApiDocsHtml } from "./openapi.js";
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
  readonly dashboardEnabled?: boolean | undefined;
  readonly priceEnrichmentEnabled?: boolean | undefined;
  readonly corsOrigin?: string | undefined;
  readonly getWatcherStatus: () => Pick<
    WatcherStatus,
    "running" | "watchedCount" | "reconnectsTotal"
  > &
    Partial<WatcherStatus>;
  readonly channels: readonly string[];
  readonly logger: AppLogger;
  readonly startedAtMs?: number | undefined;
  readonly shutdownSignal?: AbortSignal | undefined;
  readonly isShuttingDown?: () => boolean;
  readonly metricsCollector?: MetricsCollector;
};

const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const STRICT_JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

const JSON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  ...BASE_SECURITY_HEADERS,
  "Content-Security-Policy": STRICT_JSON_CSP,
};

const EventTypeEnum = z.enum(["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"]);

const CreateWalletBodySchema = z
  .object({
    address: z.string().min(1),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const UpdateWalletBodySchema = z
  .object({
    label: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((val) => val.label !== undefined || val.enabled !== undefined, {
    message: "At least one of 'label' or 'enabled' must be provided",
  });

const UpsertRuleBodySchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    walletAddress: z.string().trim().min(1).nullable().optional(),
    minSol: z.string().trim().default("0"),
    minUsd: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
    eventTypes: z
      .array(EventTypeEnum)
      .max(4)
      .default(["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"]),
    mintAllowlist: z.array(z.string().trim().min(1)).max(100).default([]),
    mintDenylist: z.array(z.string().trim().min(1)).max(100).default([]),
    includeFailed: z.boolean().default(false),
    cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

const PatchRuleBodySchema = z
  .object({
    walletAddress: z.string().trim().min(1).nullable().optional(),
    minSol: z.string().trim().optional(),
    minUsd: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
    eventTypes: z.array(EventTypeEnum).max(4).optional(),
    mintAllowlist: z.array(z.string().trim().min(1)).max(100).optional(),
    mintDenylist: z.array(z.string().trim().min(1)).max(100).optional(),
    includeFailed: z.boolean().optional(),
    cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (val) => Object.values(val).some((entry) => entry !== undefined),
    "At least one rule field must be provided",
  );

const DenylistMintBodySchema = z
  .object({
    mint: z.string().trim().min(1),
  })
  .strict();

const TestAlertBodySchema = z
  .object({
    walletAddress: z.string().trim().min(1).optional(),
  })
  .strict();

function formatZodIssues(error: z.ZodError): readonly { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function serializeRule(rule: AlertRule) {
  return {
    id: rule.id,
    walletAddress: rule.walletAddress,
    minSolLamports: rule.minSolLamports.toString(),
    minUsd: rule.minUsd ?? null,
    eventTypes: rule.eventTypes,
    mintAllowlist: rule.mintAllowlist,
    mintDenylist: rule.mintDenylist,
    includeFailed: rule.includeFailed,
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
  };
}

function serializeWallet(wallet: WatchedWallet) {
  return {
    ...wallet,
    lastSlot: wallet.lastSlot?.toString() ?? null,
    lastRpcSlot: wallet.lastRpcSlot?.toString() ?? null,
  };
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

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

function jsonErrorResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      ...JSON_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlCspHeader(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

async function parseJsonRequestBody(c: Context, errorMessage: string): Promise<unknown> {
  if (!isJsonMediaType(c.req.header("content-type"))) {
    return null;
  }
  try {
    return await c.req.json();
  } catch (err) {
    throw new ValidationError(errorMessage, undefined, err);
  }
}

export function createApiApp(options: ApiServerOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const rateLimitMax = options.rateLimitMax ?? 120;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
  const dashboardEnabled = options.dashboardEnabled ?? true;
  const authRequired = options.apiToken !== undefined;
  const metricsCollector = options.metricsCollector ?? new MetricsCollector();

  const corsHeaders: Record<string, string> = options.corsOrigin
    ? {
        "Access-Control-Allow-Origin": options.corsOrigin,
        Vary: "Origin",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      }
    : {};

  app.use("*", async (c, next) => {
    const incomingReqId = c.req.header("x-request-id");
    const requestId =
      incomingReqId && /^[a-zA-Z0-9_-]{1,64}$/.test(incomingReqId) ? incomingReqId : randomUUID();

    const startHr = process.hrtime.bigint();

    if (options.corsOrigin && c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...JSON_SECURITY_HEADERS,
          ...corsHeaders,
          "X-Request-Id": requestId,
        },
      });
    }

    await next();

    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9;
    metricsCollector.recordHttpRequest(c.req.method, c.req.path, c.res.status, durationSec);

    c.res.headers.set("X-Request-Id", requestId);
    for (const [header, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      c.res.headers.set(header, value);
    }
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.res.headers.set("Content-Security-Policy", STRICT_JSON_CSP);
    }
    for (const [header, value] of Object.entries(corsHeaders)) {
      c.res.headers.set(header, value);
    }
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/webhooks/")) {
      c.res.headers.set("Cache-Control", "no-store");
    }
    return undefined;
  });

  app.notFound(() => {
    return jsonErrorResponse(
      404,
      {
        error: "NOT_FOUND",
        message: "Route not found",
      },
      corsHeaders,
    );
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        options.logger.error({ err, path: c.req.path }, "Upstream API error");
        return jsonErrorResponse(
          err.statusCode,
          {
            error: err.code,
            message: "Upstream service error",
          },
          corsHeaders,
        );
      }

      const payload: Record<string, unknown> = {
        error: err.code,
        message: err.message,
      };
      if (err.details !== undefined) {
        payload.details = err.details;
      }
      return jsonErrorResponse(err.statusCode, payload, corsHeaders);
    }

    if (err instanceof HTTPException) {
      return jsonErrorResponse(
        err.status,
        {
          error: "HTTP_ERROR",
          message: err.message,
        },
        corsHeaders,
      );
    }

    options.logger.error({ err, path: c.req.path }, "Unhandled API error");
    return jsonErrorResponse(
      500,
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected server error occurred",
      },
      corsHeaders,
    );
  });

  const rateLimiter = createRateLimitMiddleware({
    windowMs: rateLimitWindowMs,
    maxRequests: rateLimitMax,
    trustProxy: options.trustProxy ?? false,
    keyGenerator: options.rateLimitKeyGenerator,
    securityHeaders: { ...JSON_SECURITY_HEADERS, ...corsHeaders },
  });

  app.use("/healthz", rateLimiter);
  app.use("/readyz", rateLimiter);
  app.use("/metrics", rateLimiter);
  app.use("/api/*", rateLimiter);
  app.use("/webhooks/*", rateLimiter);

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.get("/readyz", (c) => {
    if (options.isShuttingDown?.()) {
      return jsonErrorResponse(
        503,
        {
          status: "not_ready",
          reason: "shutting_down",
          timestamp: new Date().toISOString(),
        },
        corsHeaders,
      );
    }

    const dbAlive = options.store.ping();
    if (!dbAlive) {
      return jsonErrorResponse(
        503,
        {
          status: "not_ready",
          reason: "database_unresponsive",
          timestamp: new Date().toISOString(),
        },
        corsHeaders,
      );
    }

    const watchedCount = options.store.countWallets();
    const watcherStatus = options.getWatcherStatus();
    const connectedCount = watcherStatus.connectedCount ?? (watcherStatus.running ? 1 : 0);
    if (watchedCount > 0 && (connectedCount === 0 || !watcherStatus.running)) {
      return jsonErrorResponse(
        503,
        {
          status: "not_ready",
          reason: "watcher_disconnected",
          error: "No active WebSocket subscriptions connected for watched wallets",
          timestamp: new Date().toISOString(),
        },
        corsHeaders,
      );
    }

    return c.json({
      status: "ready",
      timestamp: new Date().toISOString(),
      checks: {
        database: "ok",
        watcher: watcherStatus.running ? "running" : "idle",
        watchedWallets: watchedCount,
        connectedSubscriptions: connectedCount,
      },
    });
  });

  app.get("/metrics", (c) => {
    if (options.apiToken !== undefined) {
      const authHeader = c.req.header("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!token || !timingSafeMatch(token, options.apiToken)) {
        throw new AuthError("Invalid or missing Bearer token");
      }
    }

    const text = metricsCollector.renderPrometheusText({
      serviceMetrics: options.service.getMetrics(),
      watchedWallets: options.store.countWallets(),
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1_000),
    });

    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.text(text);
  });

  if (dashboardEnabled) {
    app.get("/", (c) => {
      const nonce = randomBytes(16).toString("base64url");
      c.header("Content-Security-Policy", htmlCspHeader(nonce));
      c.header("Cache-Control", "no-store");
      return c.html(
        renderDashboardHtml({
          nonce,
          cluster: options.cluster,
          authRequired,
        }),
      );
    });

    app.get("/openapi.json", (c) => {
      return c.json(
        buildOpenApiSpec({
          cluster: options.cluster,
          authRequired,
        }),
      );
    });

    app.get("/docs", (c) => {
      const nonce = randomBytes(16).toString("base64url");
      c.header("Content-Security-Policy", htmlCspHeader(nonce));
      c.header("Cache-Control", "no-store");
      return c.html(renderApiDocsHtml(nonce, authRequired));
    });
  }

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () =>
        jsonErrorResponse(
          413,
          {
            error: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds maximum allowed size",
          },
          corsHeaders,
        ),
    }),
  );

  app.use(
    "/webhooks/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () =>
        jsonErrorResponse(
          413,
          {
            error: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds maximum allowed size",
          },
          corsHeaders,
        ),
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

  const buildStatusPayload = () => ({
    status: "ok" as const,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1_000),
    cluster: options.cluster,
    priceEnrichmentEnabled: options.priceEnrichmentEnabled ?? false,
    watchedWallets: options.store.countWallets(),
    watcher: options.getWatcherStatus(),
    channels: options.channels,
    metrics: options.service.getMetrics(),
  });

  app.get("/api/status", (c) => {
    return c.json(buildStatusPayload());
  });

  app.get("/api/wallets", (c) => {
    return c.json({ wallets: options.store.listWallets().map(serializeWallet) });
  });

  app.get("/api/wallets/:address", (c) => {
    const address = parseWalletAddress(c.req.param("address"));
    const wallet = options.store.getWallet(address);
    if (!wallet) {
      throw new NotFoundError("Wallet", { address });
    }
    const rules = options.store.listRulesForWallet(address).map(serializeRule);
    return c.json({ wallet: serializeWallet(wallet), rules });
  });

  app.post("/api/wallets", async (c) => {
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsedBody = CreateWalletBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      throw new ValidationError("Invalid wallet request payload", {
        issues: formatZodIssues(parsedBody.error),
      });
    }

    const address = parseWalletAddress(parsedBody.data.address);
    const label =
      parsedBody.data.label !== undefined
        ? sanitizeControlChars(parsedBody.data.label, 80) || null
        : null;
    const wallet = await options.service.addWallet(address, label);
    return c.json({ wallet: serializeWallet(wallet) }, 201);
  });

  app.patch("/api/wallets/:address", async (c) => {
    const address = parseWalletAddress(c.req.param("address"));
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsedBody = UpdateWalletBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      throw new ValidationError("Invalid wallet update payload", {
        issues: formatZodIssues(parsedBody.error),
      });
    }

    const updated = await options.service.updateWallet(address, {
      label: parsedBody.data.label,
      enabled: parsedBody.data.enabled,
    });
    if (!updated) {
      throw new NotFoundError("Wallet", { address });
    }
    return c.json({ wallet: serializeWallet(updated) });
  });

  app.delete("/api/wallets/:address", async (c) => {
    const address = parseWalletAddress(c.req.param("address"));
    const deleted = await options.service.removeWallet(address);
    if (!deleted) {
      throw new NotFoundError("Wallet", { address });
    }
    return c.json({ deleted: true, address });
  });

  app.get("/api/rules", (c) => {
    const walletParam = c.req.query("wallet");
    const rules =
      walletParam !== undefined && walletParam.trim().length > 0
        ? options.store.listRulesForWallet(parseWalletAddress(walletParam))
        : options.store.listAllRules();
    return c.json({ rules: rules.map(serializeRule) });
  });

  const buildRuleFromInput = (
    ruleId: ReturnType<typeof parseRuleId>,
    data: z.infer<typeof UpsertRuleBodySchema>,
  ): AlertRule => {
    let walletAddress: WalletAddress | null = null;
    if (data.walletAddress !== undefined && data.walletAddress !== null) {
      walletAddress = parseWalletAddress(data.walletAddress);
      if (!options.store.getWallet(walletAddress)) {
        throw new NotFoundError("Wallet", { address: walletAddress });
      }
    }

    return {
      id: ruleId,
      walletAddress,
      minSolLamports: parseSolToLamports(data.minSol),
      minUsd: data.minUsd ?? null,
      eventTypes: data.eventTypes,
      mintAllowlist: data.mintAllowlist.map(parseMintAddress),
      mintDenylist: data.mintDenylist.map(parseMintAddress),
      includeFailed: data.includeFailed,
      cooldownSeconds: data.cooldownSeconds,
      enabled: data.enabled,
    };
  };

  app.post("/api/rules", async (c) => {
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsed = UpsertRuleBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("Invalid alert rule payload", {
        issues: formatZodIssues(parsed.error),
      });
    }

    const ruleId = parseRuleId(parsed.data.id ?? `rule-${randomUUID().slice(0, 8)}`);
    const rule = buildRuleFromInput(ruleId, parsed.data);
    options.service.upsertRule(rule, { managedByEnv: false });
    return c.json({ rule: serializeRule(rule) }, 201);
  });

  app.put("/api/rules/:id", async (c) => {
    const ruleId = parseRuleId(c.req.param("id"));
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsed = UpsertRuleBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("Invalid alert rule payload", {
        issues: formatZodIssues(parsed.error),
      });
    }

    const rule = buildRuleFromInput(ruleId, parsed.data);
    options.service.upsertRule(rule, { managedByEnv: false });
    return c.json({ rule: serializeRule(rule) });
  });

  app.patch("/api/rules/:id", async (c) => {
    const ruleId = parseRuleId(c.req.param("id"));
    const existing = options.store.getRule(ruleId);
    if (!existing) {
      throw new NotFoundError("Rule", { id: ruleId });
    }

    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsed = PatchRuleBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("Invalid partial rule payload", {
        issues: formatZodIssues(parsed.error),
      });
    }

    let nextWallet = existing.walletAddress;
    if (parsed.data.walletAddress !== undefined) {
      if (parsed.data.walletAddress === null) {
        nextWallet = null;
      } else {
        const addr = parseWalletAddress(parsed.data.walletAddress);
        if (!options.store.getWallet(addr)) {
          throw new NotFoundError("Wallet", { address: addr });
        }
        nextWallet = addr;
      }
    }

    const updated: AlertRule = {
      id: existing.id,
      walletAddress: nextWallet,
      minSolLamports:
        parsed.data.minSol !== undefined
          ? parseSolToLamports(parsed.data.minSol)
          : existing.minSolLamports,
      minUsd: parsed.data.minUsd !== undefined ? parsed.data.minUsd : (existing.minUsd ?? null),
      eventTypes: parsed.data.eventTypes ?? existing.eventTypes,
      mintAllowlist:
        parsed.data.mintAllowlist !== undefined
          ? parsed.data.mintAllowlist.map(parseMintAddress)
          : existing.mintAllowlist,
      mintDenylist:
        parsed.data.mintDenylist !== undefined
          ? parsed.data.mintDenylist.map(parseMintAddress)
          : existing.mintDenylist,
      includeFailed: parsed.data.includeFailed ?? existing.includeFailed,
      cooldownSeconds: parsed.data.cooldownSeconds ?? existing.cooldownSeconds,
      enabled: parsed.data.enabled ?? existing.enabled,
    };

    options.service.upsertRule(updated, { managedByEnv: false });
    return c.json({ rule: serializeRule(updated) });
  });

  app.delete("/api/rules/:id", (c) => {
    const ruleId = parseRuleId(c.req.param("id"));
    const deleted = options.service.deleteRule(ruleId);
    if (!deleted) {
      throw new NotFoundError("Rule", { id: ruleId });
    }
    return c.json({ deleted: true, id: ruleId });
  });

  app.post("/api/rules/denylist", async (c) => {
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsed = DenylistMintBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("Invalid denylist payload", {
        issues: formatZodIssues(parsed.error),
      });
    }

    const mint = parseMintAddress(parsed.data.mint);
    const updated = options.service.denylistMintGlobal(mint);
    return c.json({ rule: serializeRule(updated) });
  });

  app.get("/api/alerts", (c) => {
    const limitParam = c.req.query("limit");
    const walletParam = c.req.query("wallet");
    const beforeIdParam = c.req.query("beforeId");
    const statusParam = c.req.query("status");
    const channelParam = c.req.query("channel");

    let limit = 25;
    if (limitParam !== undefined) {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        throw new ValidationError("Query parameter 'limit' must be an integer between 1 and 200");
      }
      limit = parsedLimit;
    }

    let beforeId: number | undefined;
    if (beforeIdParam !== undefined && beforeIdParam.trim().length > 0) {
      const parsedBefore = Number(beforeIdParam);
      if (!Number.isInteger(parsedBefore) || parsedBefore < 1) {
        throw new ValidationError("Query parameter 'beforeId' must be a positive integer");
      }
      beforeId = parsedBefore;
    }

    let statusFilter: "sent" | "failed" | undefined;
    if (statusParam !== undefined && statusParam.trim().length > 0) {
      if (statusParam !== "sent" && statusParam !== "failed") {
        throw new ValidationError("Query parameter 'status' must be 'sent' or 'failed'");
      }
      statusFilter = statusParam;
    }

    let channelFilter: string | undefined;
    if (channelParam !== undefined && channelParam.trim().length > 0) {
      if (channelParam.trim().length > 32) {
        throw new ValidationError("Query parameter 'channel' is too long");
      }
      channelFilter = channelParam.trim();
    }

    const wallet: WalletAddress | undefined =
      walletParam !== undefined && walletParam.trim().length > 0
        ? parseWalletAddress(walletParam)
        : undefined;

    const alerts = options.store.listRecentAlerts(limit, wallet, {
      beforeId,
      status: statusFilter,
      channel: channelFilter,
    });
    const lastAlert = alerts.at(-1);
    const nextCursor = alerts.length === limit && lastAlert ? lastAlert.id : null;

    return c.json({ alerts, nextCursor });
  });

  app.post("/api/alerts/test", async (c) => {
    const rawBody = await parseJsonRequestBody(c, "Request body must be valid JSON");
    if (rawBody === null && !isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
    }

    const parsed = TestAlertBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("Invalid test alert payload", {
        issues: formatZodIssues(parsed.error),
      });
    }

    const walletAddress = parsed.data.walletAddress
      ? parseWalletAddress(parsed.data.walletAddress)
      : undefined;
    const outcome = await options.service.sendTestAlert(walletAddress, options.shutdownSignal);
    return c.json(outcome);
  });

  app.get("/api/events/stream", (c) => {
    const encoder = new TextEncoder();
    let cleanupStream: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let unsubscribe: (() => void) | null = null;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

        const closeAll = () => {
          if (closed) return;
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
          c.req.raw.signal.removeEventListener("abort", closeAll);
          options.shutdownSignal?.removeEventListener("abort", closeAll);
          try {
            controller.close();
          } catch {
            // Stream controller already closed
          }
        };
        cleanupStream = closeAll;

        const pushFrame = (eventName: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${safeJsonStringify(data)}\n\n`),
            );
          } catch {
            closeAll();
          }
        };

        pushFrame("snapshot", {
          recentEvents: options.service.getRecentStreamEvents(),
          status: buildStatusPayload(),
        });

        unsubscribe = options.service.subscribeEvents((event) => {
          pushFrame("activity", event);
        });

        keepaliveTimer = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            closeAll();
          }
        }, 15_000);
        keepaliveTimer.unref();

        c.req.raw.signal.addEventListener("abort", closeAll, { once: true });
        options.shutdownSignal?.addEventListener("abort", closeAll, { once: true });
        if (c.req.raw.signal.aborted || options.shutdownSignal?.aborted) {
          closeAll();
        }
      },
      cancel() {
        cleanupStream?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        ...JSON_SECURITY_HEADERS,
        ...corsHeaders,
      },
    });
  });

  app.post("/webhooks/helius", async (c) => {
    if (options.heliusWebhookSecret === undefined) {
      return jsonErrorResponse(
        503,
        {
          error: "WEBHOOK_DISABLED",
          message: "Helius webhook ingestion requires HELIUS_WEBHOOK_SECRET to be configured",
        },
        corsHeaders,
      );
    }

    const rawAuth = c.req.header("authorization") ?? "";
    const provided = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7).trim() : rawAuth.trim();
    if (!provided || !timingSafeMatch(provided, options.heliusWebhookSecret)) {
      throw new AuthError("Invalid Helius webhook authorization");
    }

    if (!isJsonMediaType(c.req.header("content-type"))) {
      return jsonErrorResponse(
        415,
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json",
        },
        corsHeaders,
      );
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
