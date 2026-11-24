import { Writable } from "node:stream";
import { Hono } from "hono";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRateLimitMiddleware } from "../../src/api/rateLimit.js";
import { parseEnvConfig, redactUrlSecrets } from "../../src/config.js";
import { NotifierError, RpcError, ValidationError } from "../../src/domain/errors.js";
import { createLogger } from "../../src/logger.js";
import { postJsonWithRetry } from "../../src/notifiers/types.js";
import { signWebhookPayload, verifyWebhookSignature } from "../../src/notifiers/webhookNotifier.js";
import {
  escapeDiscordMarkdown,
  sanitizeControlChars,
  sanitizeSecretText,
} from "../../src/security/sanitize.js";
import {
  assertResolvedHostPublic,
  isBlockedHostname,
  isLoopbackHost,
  isPrivateOrReservedIp,
  validateDiscordWebhookUrl,
  validateOutboundUrl,
} from "../../src/security/ssrf.js";

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const STRONG_SECRET = "s3cr3t_token_value_with_32_plus_chars";

describe("security primitives and hardening controls", () => {
  it("strips ANSI CSI, OSC, and C0/C1 control characters safely", () => {
    const csi = "\u001b[31mRed Alert\u001b[0m";
    const oscBel = "\u001b]0;Spoofed Title\u0007Wallet";
    const oscSt = "\u001b]8;;https://evil.test\u001b\\Click";
    const mixed = `${csi}\r\n\t${oscBel}\u007f\u0085 ${oscSt}`;

    expect(sanitizeControlChars(mixed)).toBe("Red Alert   Wallet Click");
    expect(sanitizeControlChars("   Treasury Label   ", 8)).toBe("Treasury");
    expect(sanitizeControlChars("\u001bPbad\u001bXclean")).toBe("badclean");
  });

  it("escapes Discord markdown phishing constructs without corrupting -> arrows", () => {
    const raw = "> [Claim Reward](https://evil.test) **urgent** _now_ `code` ~x~ ||y||";
    const escaped = escapeDiscordMarkdown(raw);
    expect(escaped).toBe(
      "\\> \\[Claim Reward\\]\\(https://evil.test\\) \\*\\*urgent\\*\\* \\_now\\_ \\`code\\` \\~x\\~ \\|\\|y\\|\\|",
    );
    expect(escapeDiscordMarkdown("Swap on Jupiter: 1 SOL -> 180 USDC")).toBe(
      "Swap on Jupiter: 1 SOL -> 180 USDC",
    );
  });

  it("redacts path-embedded and query-embedded credentials across RPC, Telegram, and Discord URLs", () => {
    expect(redactUrlSecrets("https://solana-mainnet.g.alchemy.com/v2/alc_key_secret_123")).toBe(
      "https://solana-mainnet.g.alchemy.com/v2/***",
    );
    expect(
      redactUrlSecrets(
        "https://cool-frost.solana-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef/",
      ),
    ).toBe("https://cool-frost.solana-mainnet.quiknode.pro/***/");
    expect(
      redactUrlSecrets("https://api.telegram.org/bot123456789:AAHSecretTokenValue/sendMessage"),
    ).toBe("https://api.telegram.org/bot***/sendMessage");
    expect(redactUrlSecrets("https://discord.com/api/webhooks/12345/secretWebhookTokenValue")).toBe(
      "https://discord.com/api/webhooks/***/***",
    );
    expect(redactUrlSecrets("https://rpc.example.com/?auth=topsecret&x-api-key=secret2")).toBe(
      "https://rpc.example.com/?auth=***&x-api-key=***",
    );
  });

  it("scrubs secrets, bearer headers, bot tokens, and ANSI sequences from error text", () => {
    const raw =
      "\u001b[31mFailed calling https://api.telegram.org/bot987654321:AAH_very_secret_bot_tok/sendMessage Bearer secret_bearer_token123 987654321:AAH_very_secret_bot_tok\u001b[0m";
    const scrubbed = sanitizeSecretText(raw);
    expect(scrubbed).not.toContain("AAH_very_secret_bot_tok");
    expect(scrubbed).not.toContain("secret_bearer_token123");
    expect(scrubbed).not.toContain("\u001b");
    expect(scrubbed).toContain("https://api.telegram.org/bot***/sendMessage");
    expect(scrubbed).toContain("Bearer [REDACTED]");
    expect(scrubbed).toContain("[REDACTED_BOT_TOKEN]");
    expect(sanitizeSecretText("x".repeat(50), 10)).toHaveLength(10);
  });

  it("identifies reserved IPv4, IPv6, loopback, and cloud metadata targets accurately", () => {
    const reservedIps = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1%eth0",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::10.0.0.1",
      "100::1",
      "2001:db8::1",
    ];
    for (const ip of reservedIps) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }

    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrReservedIp("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(false);

    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);

    expect(isBlockedHostname("localhost.")).toBe(true);
    expect(isBlockedHostname("app.local")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("hooks.example.com")).toBe(false);
  });

  it("blocks disallowed schemes, IP encodings, metadata targets, Discord bypasses, and private DNS resolutions", async () => {
    const blockedUrls = [
      "file:///etc/passwd",
      "gopher://1.1.1.1:70/",
      "javascript:alert(1)",
      "https://user:pass@hooks.example.com/hook",
      "http://0177.0.0.1/hook",
      "http://2130706433/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://[::ffff:169.254.169.254]/latest",
      "https://sub.localhost/hook",
    ];
    for (const raw of blockedUrls) {
      expect(() =>
        validateOutboundUrl(raw, {
          allowedProtocols: ["https:"],
          allowPrivateHosts: false,
        }),
      ).toThrow(ValidationError);
    }

    expect(() =>
      validateOutboundUrl("http://169.254.169.254/latest/meta-data", {
        allowedProtocols: ["https:", "http:"],
        allowPrivateHosts: true,
      }),
    ).toThrow(ValidationError);

    expect(
      validateDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/123456/tokenValue").hostname,
    ).toBe("ptb.discord.com");
    expect(() => validateDiscordWebhookUrl("https://evil.com/api/webhooks/123/abc")).toThrow(
      ValidationError,
    );
    expect(() => validateDiscordWebhookUrl("https://discord.com/api/webhooks/123")).toThrow(
      ValidationError,
    );

    await expect(
      assertResolvedHostPublic("hooks.example.com", async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toEqual(["93.184.216.34"]);

    await expect(
      assertResolvedHostPublic("dual.example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toThrow(NotifierError);

    await expect(assertResolvedHostPublic("empty.example.com", async () => [])).rejects.toThrow(
      NotifierError,
    );

    await expect(
      assertResolvedHostPublic("nx.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(NotifierError);
  });

  it("redacts secrets across nested log depths and sanitizes cyclic Error causes in Pino", () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger("info", sink);

    const rootErr = new RpcError(
      "Failed at https://mainnet.helius-rpc.com/?api-key=secret-key-999",
      {
        retryable: true,
        statusCode: 502,
      },
    );
    const outerErr = new Error("Upstream Bearer top_secret_bearer_token") as Error & {
      cause?: unknown;
    };
    outerErr.cause = rootErr;
    // Introduce cycle to confirm serializer handles cyclic error properties without overflowing
    const cyclic = new Error("Cyclic") as Error & { cause?: unknown };
    cyclic.cause = cyclic;

    logger.error(
      {
        apiToken: "top-secret-api-token",
        req: { headers: { authorization: "Bearer header-secret-token" } },
        nested: {
          telegramBotToken: "123456:SecretBotToken",
          deep: { solanaRpcUrl: "https://rpc/?key=abc" },
        },
        err: outerErr,
      },
      "Request failed",
    );
    logger.error({ err: cyclic }, "Cyclic error check");

    const output = chunks.join("\n");
    expect(output).not.toContain("top-secret-api-token");
    expect(output).not.toContain("header-secret-token");
    expect(output).not.toContain("SecretBotToken");
    expect(output).not.toContain("secret-key-999");
    expect(output).not.toContain("top_secret_bearer_token");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("api-key=***");
    expect(output).toContain("[Circular]");
  });

  it("enforces fail-closed env config for non-loopback bind, secret length, Telegram admins, and SSRF", () => {
    expect(() =>
      parseEnvConfig({
        HOST: "0.0.0.0",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseEnvConfig({
        HOST: "0.0.0.0",
        ALLOW_UNAUTHENTICATED_API: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(ValidationError);

    const devOverride = parseEnvConfig({
      HOST: "0.0.0.0",
      ALLOW_UNAUTHENTICATED_API: "true",
      NODE_ENV: "development",
    });
    expect(devOverride.host).toBe("0.0.0.0");

    const prodWithToken = parseEnvConfig({
      HOST: "0.0.0.0",
      API_TOKEN: STRONG_SECRET,
      NODE_ENV: "production",
    });
    expect(prodWithToken.apiToken).toBe(STRONG_SECRET);

    expect(() => parseEnvConfig({ API_TOKEN: "too-short" })).toThrow(ValidationError);
    expect(() => parseEnvConfig({ HELIUS_WEBHOOK_SECRET: "too-short" })).toThrow(ValidationError);
    expect(() => parseEnvConfig({ WEBHOOK_SECRET: "too-short" })).toThrow(ValidationError);

    expect(() => parseEnvConfig({ TELEGRAM_ALERT_CHAT_ID: "not-a-number" })).toThrow(
      ValidationError,
    );
    expect(() => parseEnvConfig({ TELEGRAM_BOT_TOKEN: "12345:abc/def" })).toThrow(ValidationError);
    expect(() =>
      parseEnvConfig({
        TELEGRAM_INTERACTIVE_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "12345:ABC_token",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100123456",
      }),
    ).toThrow(ValidationError);

    const groupCfg = parseEnvConfig({
      TELEGRAM_INTERACTIVE_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "12345:ABC_token",
      TELEGRAM_ALLOWED_CHAT_IDS: "-100123456",
      TELEGRAM_ALLOWED_USER_IDS: "42, 43",
    });
    expect(groupCfg.telegramAllowedUserIds).toEqual(["42", "43"]);

    const ssrfUrl = "https://127.0.0.1/internal-secret-path";
    let thrownMessage = "";
    try {
      parseEnvConfig({ WEBHOOK_URL: ssrfUrl });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : "";
    }
    expect(thrownMessage).toContain("Invalid WEBHOOK_URL");
    expect(thrownMessage).not.toContain("internal-secret-path");

    const allowPrivateWebhook = parseEnvConfig({
      WEBHOOK_URL: "http://127.0.0.1:4000/hook",
      ALLOW_PRIVATE_WEBHOOK_URLS: "true",
    });
    expect(allowPrivateWebhook.allowPrivateWebhookUrls).toBe(true);

    expect(() =>
      parseEnvConfig({
        SOLANA_RPC_URL: "file:///etc/passwd",
      }),
    ).toThrow(ValidationError);

    const localValidatorCfg = parseEnvConfig({
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
      SOLANA_WS_URL: "ws://127.0.0.1:8900",
    });
    expect(localValidatorCfg.solanaRpcUrl).toBe("http://127.0.0.1:8899");
  });

  it("verifies timestamp-bound webhook HMAC signatures and rejects replay/tampering", () => {
    const rawBody = JSON.stringify({ hello: "solana" });
    const timestampSec = "1760000000";
    const deliveryId = "deliv_abc";
    const eventKind = "sol_transfer";
    const sig = signWebhookPayload({
      timestampSec,
      deliveryId,
      eventKind,
      rawBody,
      secret: STRONG_SECRET,
    });

    expect(
      verifyWebhookSignature({
        rawBody,
        signatureHeader: sig,
        timestampHeader: timestampSec,
        deliveryId,
        eventKind,
        secret: STRONG_SECRET,
        nowSec: 1_760_000_120,
      }),
    ).toBe(true);

    expect(
      verifyWebhookSignature({
        rawBody: `${rawBody} `,
        signatureHeader: sig,
        timestampHeader: timestampSec,
        deliveryId,
        eventKind,
        secret: STRONG_SECRET,
        nowSec: 1_760_000_120,
      }),
    ).toBe(false);

    expect(
      verifyWebhookSignature({
        rawBody,
        signatureHeader: sig,
        timestampHeader: timestampSec,
        deliveryId: "deliv_other",
        eventKind,
        secret: STRONG_SECRET,
        nowSec: 1_760_000_120,
      }),
    ).toBe(false);

    expect(
      verifyWebhookSignature({
        rawBody,
        signatureHeader: sig,
        timestampHeader: timestampSec,
        deliveryId,
        eventKind,
        secret: STRONG_SECRET,
        nowSec: 1_760_000_400,
      }),
    ).toBe(false);

    expect(
      verifyWebhookSignature({
        rawBody,
        signatureHeader: sig,
        timestampHeader: "not-a-timestamp",
        deliveryId,
        eventKind,
        secret: STRONG_SECRET,
        nowSec: 1_760_000_000,
      }),
    ).toBe(false);
  });

  it("blocks HTTP 302 redirects and bounds error response body reads in outbound HTTP helper", async () => {
    mswServer.use(
      http.post("https://hooks.example.com/redirect", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }),
      http.post("https://hooks.example.com/huge-error", () => {
        const bigBody = "A".repeat(64 * 1024);
        return new HttpResponse(bigBody, { status: 400 });
      }),
    );

    await expect(
      postJsonWithRetry({
        channel: "webhook",
        url: "https://hooks.example.com/redirect",
        body: "{}",
        maxRetries: 0,
      }),
    ).rejects.toThrow(NotifierError);

    await expect(
      postJsonWithRetry({
        channel: "webhook",
        url: "https://hooks.example.com/huge-error",
        body: "{}",
        maxRetries: 0,
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("rate-limits requests with bounded key eviction and optional X-Forwarded-For trust", async () => {
    let clockMs = 1_000_000;
    const untrustedProxyApp = new Hono();
    untrustedProxyApp.use(
      "*",
      createRateLimitMiddleware({
        windowMs: 60_000,
        maxRequests: 2,
        maxKeys: 10,
        trustProxy: false,
        nowMs: () => clockMs,
        securityHeaders: { "X-Content-Type-Options": "nosniff" },
      }),
    );
    untrustedProxyApp.get("/ping", (c) => c.json({ ok: true }));

    // Spoofed X-Forwarded-For headers share the single local bucket when trustProxy is false
    expect(
      (await untrustedProxyApp.request("/ping", { headers: { "X-Forwarded-For": "1.1.1.1" } }))
        .status,
    ).toBe(200);
    expect(
      (await untrustedProxyApp.request("/ping", { headers: { "X-Forwarded-For": "2.2.2.2" } }))
        .status,
    ).toBe(200);
    const blockedRes = await untrustedProxyApp.request("/ping", {
      headers: { "X-Forwarded-For": "3.3.3.3" },
    });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get("retry-after")).toBe("60");
    expect(blockedRes.headers.get("x-content-type-options")).toBe("nosniff");

    clockMs += 61_000;
    expect((await untrustedProxyApp.request("/ping")).status).toBe(200);

    // When trustProxy is enabled, clients get separate buckets and eviction caps map growth
    const trustedProxyApp = new Hono();
    trustedProxyApp.use(
      "*",
      createRateLimitMiddleware({
        windowMs: 60_000,
        maxRequests: 1,
        maxKeys: 10,
        trustProxy: true,
        nowMs: () => clockMs,
      }),
    );
    trustedProxyApp.get("/ping", (c) => c.json({ ok: true }));

    for (let i = 0; i < 12; i += 1) {
      const r = await trustedProxyApp.request("/ping", {
        headers: { "X-Forwarded-For": `203.0.113.${i + 1}, 10.0.0.1` },
      });
      expect(r.status).toBe(200);
    }
    const client2Limited = await trustedProxyApp.request("/ping", {
      headers: { "X-Forwarded-For": "203.0.113.12" },
    });
    expect(client2Limited.status).toBe(429);
  });
});
