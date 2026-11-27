import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { parseTxSignature, parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import type { Notifier } from "../../src/notifiers/types.js";
import { MonitorService } from "../../src/service/monitorService.js";
import type { SolanaRpcPort } from "../../src/solana/rpcClient.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  HELIUS_WEBHOOK_FIXTURE,
  SIG_SOL_IN,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);

function setupApiTestEnv(
  options: {
    apiToken?: string;
    heliusSecret?: string;
    maxWatchedWallets?: number;
    rateLimitMax?: number;
    dashboardEnabled?: boolean;
    corsOrigin?: string;
  } = {},
) {
  const store = new SqliteStore(":memory:");
  const delivered: string[] = [];
  const fakeNotifier: Notifier = {
    channel: "memory",
    async send(env) {
      delivered.push(env.event.signature);
    },
  };
  const rpcPort: SolanaRpcPort = {
    async getTransaction() {
      return null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  };
  const service = new MonitorService({
    store,
    rpcPort,
    dispatcher: new AlertDispatcher({
      notifiers: [fakeNotifier],
      store,
      cluster: "mainnet-beta",
      logger: createLogger("silent"),
    }),
    logger: createLogger("silent"),
    maxWatchedWallets: options.maxWatchedWallets,
  });
  service.ensureDefaultGlobalRule({
    minSolLamports: 100_000_000n,
    includeFailed: false,
    cooldownSeconds: 0,
  });

  const app = createApiApp({
    service,
    store,
    cluster: "mainnet-beta",
    apiToken: options.apiToken,
    heliusWebhookSecret: options.heliusSecret,
    rateLimitMax: options.rateLimitMax,
    dashboardEnabled: options.dashboardEnabled,
    corsOrigin: options.corsOrigin,
    rateLimitKeyGenerator: () => "test-client",
    getWatcherStatus: () => ({
      running: true,
      watchedCount: store.listWallets(true).length,
      reconnectsTotal: 0,
    }),
    channels: ["memory"],
    logger: createLogger("silent"),
  });

  return { app, store, delivered, service };
}

describe("HTTP API server (Hono)", () => {
  it("serializes persisted wallet slots as exact decimal strings", async () => {
    const { app, store } = setupApiTestEnv();
    try {
      const created = await app.request("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: WATCHED_WALLET_A, label: "Synthetic wallet" }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ wallet: { lastSlot: null, lastRpcSlot: null } });
      const slot = 312500110n;
      store.updateLastSignature(walletA, parseTxSignature(SIG_SOL_IN), slot);
      for (const path of ["/api/wallets", `/api/wallets/${WATCHED_WALLET_A}`]) {
        const response = await app.request(path);
        expect(response.status).toBe(200);
        const data = await response.json();
        const expected = { lastSlot: slot.toString(), lastRpcSlot: slot.toString() };
        expect(data).toMatchObject(
          path === "/api/wallets" ? { wallets: [expected] } : { wallet: expected },
        );
      }
      const patched = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Updated synthetic wallet" }),
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        wallet: {
          label: "Updated synthetic wallet",
          lastSlot: slot.toString(),
          lastRpcSlot: slot.toString(),
        },
      });
    } finally {
      store.close();
    }
  });

  it("exposes minimal /healthz publicly and puts operational status behind /api/status auth", async () => {
    const { app, store } = setupApiTestEnv({ apiToken: "secret-api-token" });

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
    const healthJson = (await health.json()) as Record<string, unknown>;
    expect(healthJson).toEqual({ status: "ok" });

    // Operational telemetry must require Bearer token when API_TOKEN is configured
    expect((await app.request("/api/status")).status).toBe(401);
    const statusRes = await app.request("/api/status", {
      headers: { Authorization: "Bearer secret-api-token" },
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.headers.get("cache-control")).toBe("no-store");
    const statusJson = (await statusRes.json()) as { status: string; channels: string[] };
    expect(statusJson.status).toBe("ok");
    expect(statusJson.channels).toEqual(["memory"]);

    // Unauthenticated /api/* must return 401 when apiToken is configured
    const unauth = await app.request("/api/wallets");
    expect(unauth.status).toBe(401);

    const wrongAuth = await app.request("/api/wallets", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuth.status).toBe(401);

    const authHeaders = {
      Authorization: "Bearer secret-api-token",
      "Content-Type": "application/json",
    };

    // Unknown fields rejected (.strict()) and invalid address -> 400
    const strictField = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A, unexpected: true }),
    });
    expect(strictField.status).toBe(400);

    const badCreate = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: "bad-address" }),
    });
    expect(badCreate.status).toBe(400);

    // Non-JSON Content-Type rejected with 415
    const wrongContentType = await app.request("/api/wallets", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-api-token",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ address: WATCHED_WALLET_A }),
    });
    expect(wrongContentType.status).toBe(415);

    // Valid address with control chars -> 201 with sanitized label
    const created = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A, label: "\u001b[31mTreasury\u001b[0m" }),
    });
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { wallet: { label: string | null } };
    expect(createdJson.wallet.label).toBe("Treasury");

    // Duplicate -> 409
    const dup = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A }),
    });
    expect(dup.status).toBe(409);

    const list = await app.request("/api/wallets", { headers: authHeaders });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { wallets: Array<{ address: string }> };
    expect(listJson.wallets).toHaveLength(1);

    const del = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(del.status).toBe(200);

    const delMissing = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(delMissing.status).toBe(404);

    // Unknown route -> 404 JSON with security headers
    const unknownRoute = await app.request("/unknown-path");
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.headers.get("x-content-type-options")).toBe("nosniff");

    store.close();
  });

  it("enforces wallet capacity caps, JSON 413 payload limits, and per-client rate limits", async () => {
    const { app, store } = setupApiTestEnv({
      apiToken: "secret-api-token",
      maxWatchedWallets: 1,
      rateLimitMax: 4,
    });
    const authHeaders = {
      Authorization: "Bearer secret-api-token",
      "Content-Type": "application/json",
    };

    const first = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A }),
    });
    expect(first.status).toBe(201);

    const capExceeded = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: COUNTERPARTY_WALLET }),
    });
    expect(capExceeded.status).toBe(429);

    const oversized = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A, label: "x".repeat(300 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    const oversizedJson = (await oversized.json()) as { error: string };
    expect(oversizedJson.error).toBe("PAYLOAD_TOO_LARGE");

    expect((await app.request("/healthz")).status).toBe(200);
    const rateLimited = await app.request("/healthz");
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBeTruthy();

    store.close();
  });

  it("disables /webhooks/helius when secret is missing and authenticates signed batches when configured", async () => {
    const disabledEnv = setupApiTestEnv({});
    const disabledRes = await disabledEnv.app.request("/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(HELIUS_WEBHOOK_FIXTURE),
    });
    expect(disabledRes.status).toBe(503);
    expect(disabledRes.headers.get("x-content-type-options")).toBe("nosniff");
    disabledEnv.store.close();

    const { app, store, delivered, service } = setupApiTestEnv({
      heliusSecret: "helius-hook-secret",
    });
    store.createWallet(walletA, "Treasury");

    const unauth = await app.request("/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(HELIUS_WEBHOOK_FIXTURE),
    });
    expect(unauth.status).toBe(401);

    const wrongType = await app.request("/webhooks/helius", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: "helius-hook-secret",
      },
      body: JSON.stringify(HELIUS_WEBHOOK_FIXTURE),
    });
    expect(wrongType.status).toBe(415);

    const payloadWithOneBadTx = [
      ...HELIUS_WEBHOOK_FIXTURE,
      { signature: "invalid-tx", slot: "not-a-number" },
    ];

    const okRes = await app.request("/webhooks/helius", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "helius-hook-secret",
      },
      body: JSON.stringify(payloadWithOneBadTx),
    });
    expect(okRes.status).toBe(202);
    const body = (await okRes.json()) as {
      accepted: number;
      queued: number;
      dropped: number;
      skippedInvalid: number;
    };
    expect(body.accepted).toBe(3);
    expect(body.queued).toBe(3);
    expect(body.dropped).toBe(0);
    expect(body.skippedInvalid).toBe(1);

    await service.drain();
    expect(delivered).toHaveLength(3);

    const alertsRes = await app.request(`/api/alerts?limit=10&wallet=${WATCHED_WALLET_A}`);
    expect(alertsRes.status).toBe(200);
    const alertsBody = (await alertsRes.json()) as { alerts: unknown[] };
    expect(alertsBody.alerts).toHaveLength(3);

    const badLimit = await app.request("/api/alerts?limit=999");
    expect(badLimit.status).toBe(400);

    const badJsonWallet = await app.request("/api/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    expect(badJsonWallet.status).toBe(400);

    const badJsonWebhook = await app.request("/webhooks/helius", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer helius-hook-secret",
      },
      body: "{bad-json",
    });
    expect(badJsonWebhook.status).toBe(400);

    store.close();

    // Closed SQLite triggers an unhandled infrastructure error -> sanitized 500 response with security headers
    const internalErrRes = await app.request("/api/wallets");
    expect(internalErrRes.status).toBe(500);
    expect(internalErrRes.headers.get("x-content-type-options")).toBe("nosniff");
    const internalBody = (await internalErrRes.json()) as { error: string; message: string };
    expect(internalBody.error).toBe("INTERNAL_SERVER_ERROR");
    expect(internalBody.message).not.toContain("SQLite");
  });

  it("exposes rules/wallet PATCH control plane, paginated alerts, test alerts, SSE stream, OpenAPI docs, and dashboard", async () => {
    const { app, store, delivered } = setupApiTestEnv({
      apiToken: "secret-api-token",
      corsOrigin: "https://console.example.com",
    });
    const authHeaders = {
      Authorization: "Bearer secret-api-token",
      "Content-Type": "application/json",
    };

    // Preflight CORS
    const preflight = await app.request("/api/wallets", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://console.example.com",
    );

    // Embedded dashboard HTML & docs with valid script syntax and nonce CSP
    const dashRes = await app.request("/");
    expect(dashRes.status).toBe(200);
    expect(dashRes.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    const dashHtml = await dashRes.text();
    const dashScript = dashHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(dashScript.length).toBeGreaterThan(100);
    expect(() => new Function(dashScript)).not.toThrow();

    const specRes = await app.request("/openapi.json");
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/api/rules"]).toBeDefined();

    const docsRes = await app.request("/docs");
    expect(docsRes.status).toBe(200);
    const docsHtml = await docsRes.text();
    const docsScript = docsHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(() => new Function(docsScript)).not.toThrow();

    // Wallet GET/PATCH lifecycle
    await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A, label: "Vault" }),
    });

    const getWalletRes = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      headers: authHeaders,
    });
    expect(getWalletRes.status).toBe(200);

    const patchWalletRes = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ label: "Main Vault", enabled: false }),
    });
    expect(patchWalletRes.status).toBe(200);
    const patchedJson = (await patchWalletRes.json()) as {
      wallet: { label: string | null; enabled: boolean };
    };
    expect(patchedJson.wallet.label).toBe("Main Vault");
    expect(patchedJson.wallet.enabled).toBe(false);

    // Clear label explicitly via null
    const clearLabelRes = await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ label: null }),
    });
    expect(clearLabelRes.status).toBe(200);
    expect(
      ((await clearLabelRes.json()) as { wallet: { label: string | null } }).wallet.label,
    ).toBeNull();

    // Rule CRUD + denylist
    const createRuleRes = await app.request("/api/rules", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        id: "vip-whale",
        walletAddress: WATCHED_WALLET_A,
        minSol: "2.5",
        minUsd: 250,
        eventTypes: ["sol_transfer", "dex_swap"],
        cooldownSeconds: 30,
      }),
    });
    expect(createRuleRes.status).toBe(201);

    const patchRuleRes = await app.request("/api/rules/vip-whale", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ cooldownSeconds: 60, enabled: false }),
    });
    expect(patchRuleRes.status).toBe(200);

    const listRulesRes = await app.request(`/api/rules?wallet=${WATCHED_WALLET_A}`, {
      headers: authHeaders,
    });
    expect(listRulesRes.status).toBe(200);
    const listRulesJson = (await listRulesRes.json()) as { rules: Array<{ id: string }> };
    expect(listRulesJson.rules.some((r) => r.id === "vip-whale")).toBe(true);

    const denylistRes = await app.request("/api/rules/denylist", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ mint: "SpamDust11111111111111111111111111111111111" }),
    });
    expect(denylistRes.status).toBe(200);

    const delRuleRes = await app.request("/api/rules/vip-whale", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(delRuleRes.status).toBe(200);

    // Test alert dispatch + alerts cursor filter
    const testAlertRes = await app.request("/api/alerts/test", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ walletAddress: WATCHED_WALLET_A }),
    });
    expect(testAlertRes.status).toBe(200);
    expect(delivered).toHaveLength(1);

    const alertsPage = await app.request("/api/alerts?limit=1&status=sent&channel=memory", {
      headers: authHeaders,
    });
    expect(alertsPage.status).toBe(200);
    const alertsPageJson = (await alertsPage.json()) as {
      alerts: Array<{ id: number }>;
      nextCursor: number | null;
    };
    expect(alertsPageJson.alerts).toHaveLength(1);
    expect(alertsPageJson.nextCursor).toBe(alertsPageJson.alerts[0]?.id ?? null);

    // SSE stream delivers initial snapshot and subsequent wallet mutation event
    const sseController = new AbortController();
    const sseRes = await app.request("/api/events/stream", {
      headers: { Authorization: "Bearer secret-api-token" },
      signal: sseController.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseRes.body?.getReader();
    if (!reader) throw new Error("Expected SSE body reader");
    const decoder = new TextDecoder();
    const snapChunk = await reader.read();
    expect(decoder.decode(snapChunk.value)).toContain("event: snapshot");

    await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    const activityChunk = await reader.read();
    expect(decoder.decode(activityChunk.value)).toContain("wallet_updated");
    sseController.abort();
    await reader.cancel().catch(() => {});

    // Put rule + partial error & validation branches across control-plane routes
    const putRuleRes = await app.request("/api/rules/put-rule", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ minSol: "1", cooldownSeconds: 10 }),
    });
    expect(putRuleRes.status).toBe(200);
    expect(
      (await app.request("/api/rules/put-rule", { method: "DELETE", headers: authHeaders })).status,
    ).toBe(200);

    expect(
      (await app.request(`/api/wallets/${COUNTERPARTY_WALLET}`, { headers: authHeaders })).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/wallets/${COUNTERPARTY_WALLET}`, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
          method: "PATCH",
          headers: { Authorization: "Bearer secret-api-token", "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request(`/api/wallets/${WATCHED_WALLET_A}`, {
          method: "PATCH",
          headers: authHeaders,
          body: "{}",
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await app.request("/api/rules", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ walletAddress: COUNTERPARTY_WALLET, minSol: "1" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/rules/missing-rule", {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/rules/missing-rule", {
          method: "DELETE",
          headers: authHeaders,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/rules/denylist", {
          method: "POST",
          headers: { Authorization: "Bearer secret-api-token", "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request("/api/rules/denylist", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ mint: "not-a-mint" }),
        })
      ).status,
    ).toBe(400);

    expect((await app.request("/api/alerts?beforeId=0", { headers: authHeaders })).status).toBe(
      400,
    );
    expect((await app.request("/api/alerts?status=invalid", { headers: authHeaders })).status).toBe(
      400,
    );
    expect(
      (
        await app.request(`/api/alerts?channel=${"x".repeat(40)}`, {
          headers: authHeaders,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/alerts/test", {
          method: "POST",
          headers: { Authorization: "Bearer secret-api-token", "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);

    // Dashboard disabled flag + unauthenticated dashboard rendering branch
    const headless = setupApiTestEnv({ dashboardEnabled: false });
    expect((await headless.app.request("/")).status).toBe(404);
    expect((await headless.app.request("/docs")).status).toBe(404);
    headless.store.close();

    const openDash = setupApiTestEnv({});
    expect((await openDash.app.request("/")).status).toBe(200);
    expect((await openDash.app.request("/docs")).status).toBe(200);
    expect((await openDash.app.request("/openapi.json")).status).toBe(200);
    expect(
      (
        await openDash.app.request("/api/alerts/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    openDash.store.close();

    store.close();
  });

  it("supports X-Request-Id propagation, /readyz readiness probes, and Prometheus /metrics", async () => {
    let isShuttingDown = false;
    let watcherRunning = true;

    const store = new SqliteStore(":memory:");
    const service = new MonitorService({
      store,
      rpcPort: {
        getTransaction: async () => null,
        getSignaturesForAddress: async () => [],
      },
      dispatcher: new AlertDispatcher({
        notifiers: [],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
    });

    const app = createApiApp({
      service,
      store,
      cluster: "mainnet-beta",
      apiToken: "super-secret-probe-token",
      getWatcherStatus: () => ({
        running: watcherRunning,
        connectedCount: watcherRunning ? 1 : 0,
        watchedCount: store.listWallets(true).length,
        reconnectsTotal: 0,
      }),
      channels: ["test"],
      logger: createLogger("silent"),
      isShuttingDown: () => isShuttingDown,
    });

    // 1. X-Request-Id header checks
    const defaultRes = await app.request("/healthz");
    expect(defaultRes.headers.get("x-request-id")).toBeDefined();
    expect(defaultRes.headers.get("x-request-id")?.length).toBeGreaterThan(10);

    const customRes = await app.request("/healthz", {
      headers: { "x-request-id": "custom-trace-id-999" },
    });
    expect(customRes.headers.get("x-request-id")).toBe("custom-trace-id-999");

    // 2. /readyz probe checks
    const readyRes = await app.request("/readyz");
    expect(readyRes.status).toBe(200);
    const readyJson = (await readyRes.json()) as { status: string; checks: { database: string } };
    expect(readyJson.status).toBe("ready");
    expect(readyJson.checks.database).toBe("ok");

    // Watcher disconnected with active wallets
    store.createWallet(
      parseWalletAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
      "Active Wallet",
    );
    watcherRunning = false;
    const watcherErrRes = await app.request("/readyz");
    expect(watcherErrRes.status).toBe(503);
    const watcherErrJson = (await watcherErrRes.json()) as {
      status: string;
      reason: string;
      error: string;
    };
    expect(watcherErrJson.status).toBe("not_ready");
    expect(watcherErrJson.reason).toBe("watcher_disconnected");

    // Reset watcher back to running
    watcherRunning = true;

    // Shutting down state check
    isShuttingDown = true;
    const shutdownRes = await app.request("/readyz");
    expect(shutdownRes.status).toBe(503);
    const shutdownJson = (await shutdownRes.json()) as { status: string; reason: string };
    expect(shutdownJson.status).toBe("not_ready");
    expect(shutdownJson.reason).toBe("shutting_down");
    isShuttingDown = false;

    // 3. /metrics checks
    // Unauth check
    const unauthMetrics = await app.request("/metrics");
    expect(unauthMetrics.status).toBe(401);

    // Auth check
    const authMetrics = await app.request("/metrics", {
      headers: { Authorization: "Bearer super-secret-probe-token" },
    });
    expect(authMetrics.status).toBe(200);
    expect(authMetrics.headers.get("content-type")).toContain("text/plain");
    const metricsBody = await authMetrics.text();
    expect(metricsBody).toContain("# HELP solwatch_http_requests_total");
    expect(metricsBody).toContain("solwatch_watched_wallets_total 1");
    expect(metricsBody).toContain("solwatch_uptime_seconds");

    // Database unresponsive check
    store.close();
    const dbErrRes = await app.request("/readyz");
    expect(dbErrRes.status).toBe(503);
    const dbErrJson = (await dbErrRes.json()) as { status: string; reason: string };
    expect(dbErrJson.status).toBe("not_ready");
    expect(dbErrJson.reason).toBe("database_unresponsive");
  });
});
