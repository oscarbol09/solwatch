import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import type { Notifier } from "../../src/notifiers/types.js";
import { MonitorService } from "../../src/service/monitorService.js";
import type { SolanaRpcPort } from "../../src/solana/rpcClient.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  HELIUS_WEBHOOK_FIXTURE,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);

function setupApiTestEnv(
  options: {
    apiToken?: string;
    heliusSecret?: string;
    maxWatchedWallets?: number;
    rateLimitMax?: number;
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
});
