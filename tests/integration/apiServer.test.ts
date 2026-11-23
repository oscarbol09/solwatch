import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import type { Notifier } from "../../src/notifiers/types.js";
import { MonitorService } from "../../src/service/monitorService.js";
import type { SolanaRpcPort } from "../../src/solana/rpcClient.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { HELIUS_WEBHOOK_FIXTURE, WATCHED_WALLET_A } from "../fixtures/solanaTransactions.js";

const walletA = parseWalletAddress(WATCHED_WALLET_A);

function setupApiTestEnv(options: { apiToken?: string; heliusSecret?: string } = {}) {
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
    getWatcherStatus: () => ({
      running: true,
      watchedCount: store.listWallets(true).length,
      reconnectsTotal: 0,
    }),
    channels: ["memory"],
    logger: createLogger("silent"),
  });

  return { app, store, delivered };
}

describe("HTTP API server (Hono)", () => {
  it("exposes /healthz publicly and manages wallets + alerts with strict validation", async () => {
    const { app, store } = setupApiTestEnv({ apiToken: "secret-api-token" });

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { status: string; channels: string[] };
    expect(healthJson.status).toBe("ok");
    expect(healthJson.channels).toEqual(["memory"]);

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

    // Invalid address -> 400
    const badCreate = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: "bad-address" }),
    });
    expect(badCreate.status).toBe(400);

    // Valid address -> 201
    const created = await app.request("/api/wallets", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ address: WATCHED_WALLET_A, label: "Treasury" }),
    });
    expect(created.status).toBe(201);

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

    store.close();
  });

  it("authenticates Helius webhooks and routes matching events into MonitorService", async () => {
    const { app, store, delivered } = setupApiTestEnv({ heliusSecret: "helius-hook-secret" });
    store.createWallet(walletA, "Treasury");

    const unauth = await app.request("/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(HELIUS_WEBHOOK_FIXTURE),
    });
    expect(unauth.status).toBe(401);

    const okRes = await app.request("/webhooks/helius", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "helius-hook-secret",
      },
      body: JSON.stringify(HELIUS_WEBHOOK_FIXTURE),
    });
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { accepted: number; alertsDispatched: number };
    expect(body.accepted).toBe(3);
    expect(body.alertsDispatched).toBe(3);
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

    // Closed SQLite triggers an unhandled infrastructure error -> sanitized 500 response
    const internalErrRes = await app.request("/api/wallets");
    expect(internalErrRes.status).toBe(500);
    const internalBody = (await internalErrRes.json()) as { error: string; message: string };
    expect(internalBody.error).toBe("INTERNAL_SERVER_ERROR");
    expect(internalBody.message).not.toContain("SQLite");
  });
});
