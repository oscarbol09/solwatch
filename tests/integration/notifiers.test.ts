import { createHmac } from "node:crypto";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { NotifierError } from "../../src/domain/errors.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { ConsoleNotifier } from "../../src/notifiers/consoleNotifier.js";
import { DiscordNotifier } from "../../src/notifiers/discordNotifier.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import { buildAlertEnvelope } from "../../src/notifiers/format.js";
import { TelegramNotifier } from "../../src/notifiers/telegramNotifier.js";
import { WebhookNotifier } from "../../src/notifiers/webhookNotifier.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  makeJupiterSwapTx,
  makeSplUsdcTransferTx,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const watched = parseWalletAddress(WATCHED_WALLET_A);

describe("multi-channel notifiers and dispatcher (MSW contract tests)", () => {
  it("delivers Telegram HTML alert with Solscan inline button and retries on 429 retry_after", async () => {
    let calls = 0;
    let capturedBody: Record<string, unknown> | undefined;
    const sleeps: number[] = [];

    server.use(
      http.post("https://api.telegram.org/botTEST_TOKEN/sendMessage", async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { ok: false, error_code: 429, parameters: { retry_after: 1 } },
            { status: 429 },
          );
        }
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, result: { message_id: 99 } });
      }),
    );

    const notifier = new TelegramNotifier({
      botToken: "TEST_TOKEN",
      chatId: "-10012345",
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const envelope = buildAlertEnvelope(event, "Alpha Vault", "mainnet-beta", "del_tg_1");
    await notifier.send(envelope);

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
    expect(capturedBody?.chat_id).toBe("-10012345");
    expect(capturedBody?.parse_mode).toBe("HTML");
    expect(JSON.stringify(capturedBody?.reply_markup)).toContain(envelope.explorerUrl);
  });

  it("delivers Discord embed and honors Retry-After on HTTP 429", async () => {
    const discordUrl = "https://discord.com/api/webhooks/12345/secret-token";
    let calls = 0;
    let capturedPayload: Record<string, unknown> | undefined;

    server.use(
      http.post(discordUrl, async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(JSON.stringify({ message: "You are being rate limited." }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "0.1" },
          });
        }
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({
      webhookUrl: discordUrl,
      maxRetries: 1,
      sleep: async () => {},
    });

    const event = classifyParsedTransaction(makeSplUsdcTransferTx(), watched);
    await notifier.send(buildAlertEnvelope(event, "Treasury", "mainnet-beta", "del_dc_1"));

    expect(calls).toBe(2);
    expect(Array.isArray(capturedPayload?.embeds)).toBe(true);
  });

  it("signs generic webhook payloads with HMAC-SHA256 and fails fast on 400", async () => {
    const webhookUrl = "https://hooks.client.local/solana";
    const secret = "whsec_super_secret";
    let capturedSig = "";
    let capturedRawBody = "";

    server.use(
      http.post(webhookUrl, async ({ request }) => {
        capturedSig = request.headers.get("x-solwatch-signature") ?? "";
        capturedRawBody = await request.text();
        return HttpResponse.json({ received: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: webhookUrl,
      secret,
      maxRetries: 1,
      sleep: async () => {},
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    await notifier.send(buildAlertEnvelope(event, "Treasury", "mainnet-beta", "del_wh_1"));

    const expectedSig = `sha256=${createHmac("sha256", secret).update(capturedRawBody).digest("hex")}`;
    expect(capturedSig).toBe(expectedSig);

    // 400 must fail fast without retrying
    let badAttempts = 0;
    server.use(
      http.post(webhookUrl, () => {
        badAttempts += 1;
        return new HttpResponse("bad payload", { status: 400 });
      }),
    );
    const err = await notifier
      .send(buildAlertEnvelope(event, "Treasury", "mainnet-beta", "del_wh_2"))
      .catch((e) => e);

    expect(badAttempts).toBe(1);
    expect(err).toBeInstanceOf(NotifierError);
    expect((err as NotifierError).retryable).toBe(false);
  });

  it("isolates failing channels in AlertDispatcher and records every channel outcome in SQLite", async () => {
    const store = new SqliteStore(":memory:");
    store.createWallet(watched, "Treasury");

    const discordUrl = "https://discord.com/api/webhooks/fail/endpoint";
    const webhookUrl = "https://hooks.client.local/ok";
    server.use(
      http.post(discordUrl, () => new HttpResponse("down", { status: 500 })),
      http.post(webhookUrl, () => HttpResponse.json({ ok: true })),
    );

    const consoleWrites: string[] = [];
    const dispatcher = new AlertDispatcher({
      notifiers: [
        new ConsoleNotifier((line) => consoleWrites.push(line)),
        new DiscordNotifier({ webhookUrl: discordUrl, maxRetries: 0 }),
        new WebhookNotifier({ url: webhookUrl, maxRetries: 0 }),
      ],
      store,
      cluster: "mainnet-beta",
      logger: createLogger("silent"),
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const results = await dispatcher.dispatch(event, "Treasury");

    expect(consoleWrites).toHaveLength(1);
    expect(results).toEqual([
      { channel: "console", status: "sent" },
      {
        channel: "discord",
        status: "failed",
        errorMessage: expect.stringContaining("500"),
      },
      { channel: "webhook", status: "sent" },
    ]);

    const history = store.listRecentAlerts(10);
    expect(history).toHaveLength(3);
    expect(history.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(history.filter((r) => r.status === "failed")).toHaveLength(1);
    store.close();
  });
});
