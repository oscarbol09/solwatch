import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { NotifierError, ValidationError } from "../../src/domain/errors.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { ConsoleNotifier } from "../../src/notifiers/consoleNotifier.js";
import { DiscordNotifier } from "../../src/notifiers/discordNotifier.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import { buildAlertEnvelope } from "../../src/notifiers/format.js";
import { TelegramNotifier } from "../../src/notifiers/telegramNotifier.js";
import type { Notifier } from "../../src/notifiers/types.js";
import { verifyWebhookSignature, WebhookNotifier } from "../../src/notifiers/webhookNotifier.js";
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
const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

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
      messageThreadId: 77,
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const envelope = buildAlertEnvelope(event, "Alpha Vault", "mainnet-beta", "del_tg_1", {
      estimatedUsd: 240,
      source: "websocket",
    });
    await notifier.send(envelope);

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
    expect(capturedBody?.chat_id).toBe("-10012345");
    expect(capturedBody?.message_thread_id).toBe(77);
    expect(capturedBody?.parse_mode).toBe("HTML");
    const kbText = JSON.stringify(capturedBody?.reply_markup);
    expect(kbText).toContain(envelope.explorerUrl);
    expect(kbText).toContain("dexscreener.com/solana/");
  });

  it("delivers Discord embed with disabled mentions and honors Retry-After on HTTP 429", async () => {
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
    expect(capturedPayload?.allowed_mentions).toEqual({ parse: [] });
  });

  it("signs generic webhook payloads with timestamped HMAC-SHA256 and fails fast on 400", async () => {
    const webhookUrl = "https://hooks.example.com/solana";
    const secret = "whsec_super_secret_key_with_sufficient_entropy";
    let capturedSig = "";
    let capturedTimestamp = "";
    let capturedDelivery = "";
    let capturedEvent = "";
    let capturedRawBody = "";

    server.use(
      http.post(webhookUrl, async ({ request }) => {
        capturedSig = request.headers.get("x-solwatch-signature") ?? "";
        capturedTimestamp = request.headers.get("x-solwatch-timestamp") ?? "";
        capturedDelivery = request.headers.get("x-solwatch-delivery") ?? "";
        capturedEvent = request.headers.get("x-solwatch-event") ?? "";
        capturedRawBody = await request.text();
        return HttpResponse.json({ received: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: webhookUrl,
      secret,
      resolveHost: publicResolve,
      nowSec: () => 1_760_000_000,
      maxRetries: 1,
      sleep: async () => {},
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    await notifier.send(buildAlertEnvelope(event, "Treasury", "mainnet-beta", "del_wh_1"));

    expect(capturedTimestamp).toBe("1760000000");
    expect(
      verifyWebhookSignature({
        rawBody: capturedRawBody,
        signatureHeader: capturedSig,
        timestampHeader: capturedTimestamp,
        deliveryId: capturedDelivery,
        eventKind: capturedEvent,
        secret,
        nowSec: 1_760_000_030,
      }),
    ).toBe(true);

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

  it("blocks constructor and DNS SSRF bypasses across Discord, Telegram, and Webhook notifiers", async () => {
    expect(
      () => new DiscordNotifier({ webhookUrl: "https://attacker.com/api/webhooks/1/2" }),
    ).toThrow(ValidationError);
    expect(() => new TelegramNotifier({ botToken: "123:abc/inject", chatId: "1001" })).toThrow(
      ValidationError,
    );

    const ssrfNotifier = new WebhookNotifier({
      url: "https://hooks.example.com/hook",
      resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
      maxRetries: 0,
    });
    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    await expect(
      ssrfNotifier.send(buildAlertEnvelope(event, null, "mainnet-beta", "del_ssrf")),
    ).rejects.toThrow(NotifierError);
  });

  it("isolates failing channels, redacts error messages in SQLite, and handles unconfigured channels", async () => {
    const store = new SqliteStore(":memory:");
    store.createWallet(watched, "Treasury");

    const discordUrl = "https://discord.com/api/webhooks/99999/secret_webhook_token_leak";
    const webhookUrl = "https://hooks.example.com/ok";
    server.use(
      http.post(discordUrl, () => new HttpResponse("down", { status: 500 })),
      http.post(webhookUrl, () => HttpResponse.json({ ok: true })),
    );

    const leakyNotifier: Notifier = {
      channel: "custom",
      async send() {
        throw new Error(`Failed calling ${discordUrl} Bearer leaked_bearer_secret`);
      },
    };

    const consoleWrites: string[] = [];
    const dispatcher = new AlertDispatcher({
      notifiers: [
        new ConsoleNotifier((line) => consoleWrites.push(line)),
        new DiscordNotifier({ webhookUrl: discordUrl, maxRetries: 0 }),
        new WebhookNotifier({ url: webhookUrl, maxRetries: 0, resolveHost: publicResolve }),
        leakyNotifier,
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
      {
        channel: "custom",
        status: "failed",
        errorMessage: expect.not.stringContaining("secret_webhook_token_leak"),
      },
    ]);

    const history = store.listRecentAlerts(10);
    expect(history).toHaveLength(4);
    expect(history.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(history.filter((r) => r.status === "failed")).toHaveLength(2);
    const customRow = history.find((r) => r.channel === "custom");
    expect(customRow?.errorMessage).not.toContain("leaked_bearer_secret");
    expect(customRow?.errorMessage).not.toContain("secret_webhook_token_leak");
    expect(dispatcher.getChannels()).toEqual(["console", "discord", "webhook", "custom"]);

    const emptyDispatcher = new AlertDispatcher({
      notifiers: [],
      store,
      cluster: "mainnet-beta",
      logger: createLogger("silent"),
    });
    expect(await emptyDispatcher.dispatch(event, null)).toEqual([]);

    expect(await dispatcher.dispatchToChannel("nonexistent", event, null, "del_missing")).toEqual({
      channel: "nonexistent",
      status: "failed",
      errorMessage: 'Channel "nonexistent" is not configured',
    });

    const singleFail = await dispatcher.dispatchToChannel(
      "discord",
      event,
      "Treasury",
      "del_retry",
    );
    expect(singleFail.status).toBe("failed");
    store.close();
  });

  it("retries transient network failures and respects caller AbortSignal", async () => {
    const url = "https://hooks.example.com/flaky";
    let calls = 0;
    server.use(
      http.post(url, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url,
      resolveHost: publicResolve,
      maxRetries: 1,
      sleep: async () => {},
    });
    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const envelope = buildAlertEnvelope(event, null, "mainnet-beta", "del_net_1");
    await notifier.send(envelope);
    expect(calls).toBe(2);

    const aborted = new AbortController();
    aborted.abort();
    await expect(notifier.send(envelope, aborted.signal)).rejects.toThrow(NotifierError);
  });

  it("ConsoleNotifier handles default and custom writer", async () => {
    let captured = "";
    const custom = new ConsoleNotifier((text) => {
      captured += text;
    });
    const defaultConsole = new ConsoleNotifier();
    expect(defaultConsole.channel).toBe("console");

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const envelope = buildAlertEnvelope(event, "Treasury", "mainnet-beta", "del_console_1");
    await custom.send(envelope);
    expect(captured).toContain("Swap on Jupiter");

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await defaultConsole.send(envelope);
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("TelegramNotifier selects tokenIn as primary mint when tokenOut is WSOL", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post("https://api.telegram.org/botTOKEN_SWAP_OUT/sendMessage", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, result: { message_id: 101 } });
      }),
    );

    const notifier = new TelegramNotifier({
      botToken: "TOKEN_SWAP_OUT",
      chatId: "12345",
    });

    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    if (event.kind !== "dex_swap") throw new Error("expected dex_swap");

    // Invert swap legs so tokenOut is WSOL
    const sellTokenEvent = {
      ...event,
      tokenIn: event.tokenOut,
      tokenOut: event.tokenIn,
    };
    const envelope = buildAlertEnvelope(
      sellTokenEvent,
      "Swap Reverse",
      "mainnet-beta",
      "del_rev_1",
    );
    await notifier.send(envelope);

    const kbText = JSON.stringify(capturedBody?.reply_markup);
    expect(kbText).toContain("dexscreener.com/solana/");
  });
});
