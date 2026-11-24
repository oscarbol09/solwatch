import { describe, expect, it } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import {
  buildAlertEnvelope,
  escapeHtml,
  formatConsoleLine,
  formatDiscordEmbed,
  formatTelegramHtml,
  formatWebhookPayload,
  solscanTxUrl,
} from "../../src/notifiers/format.js";
import {
  makeFailedTx,
  makeIncomingSolTx,
  makeJupiterSwapTx,
  makeOutgoingSolTx,
  makeProgramOnlyTx,
  makeSplUsdcTransferTx,
  SIG_SOL_IN,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const watched = parseWalletAddress(WATCHED_WALLET_A);

describe("alert formatters", () => {
  it("escapes unsafe HTML characters in Telegram alerts and adds cluster query params to Solscan URLs", () => {
    expect(solscanTxUrl(SIG_SOL_IN, "mainnet-beta")).toBe(`https://solscan.io/tx/${SIG_SOL_IN}`);
    expect(solscanTxUrl(SIG_SOL_IN, "devnet")).toBe(
      `https://solscan.io/tx/${SIG_SOL_IN}?cluster=devnet`,
    );
    expect(escapeHtml(`<script>alert("x&y")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;",
    );

    const event = classifyParsedTransaction(makeIncomingSolTx(), watched);
    const xssEvent =
      event.kind === "sol_transfer" ? { ...event, counterparty: "<img src=x>" } : event;
    const envelope = buildAlertEnvelope(xssEvent, "<Treasury & Ops>", "devnet", "deliv_1");
    const html = formatTelegramHtml(envelope);

    expect(html).toContain("&lt;Treasury &amp; Ops&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("+2.5 SOL");
    expect(html).toContain("?cluster=devnet");

    // Out-of-range timestamps must be omitted rather than throwing RangeError
    const hugeTsEvent = { ...event, timestampSec: 9e15 };
    const discordHuge = formatDiscordEmbed(
      buildAlertEnvelope(hugeTsEvent, null, "mainnet-beta", "del_ts"),
    );
    expect(discordHuge.embeds[0]?.timestamp).toBeUndefined();
  });

  it("formats Discord embeds, JSON-safe webhook payloads, and terminal cards across all event kinds", () => {
    const progEvent = classifyParsedTransaction(makeProgramOnlyTx(), watched);
    const events = [
      classifyParsedTransaction(makeIncomingSolTx(), watched),
      classifyParsedTransaction(makeOutgoingSolTx(), watched),
      classifyParsedTransaction(makeSplUsdcTransferTx(), watched),
      classifyParsedTransaction(makeJupiterSwapTx(), watched),
      classifyParsedTransaction(makeFailedTx(), watched),
      { ...progEvent, timestampSec: null },
    ];

    for (const [idx, event] of events.entries()) {
      const label = idx % 2 === 0 ? "Main Wallet" : null;
      const envelope = buildAlertEnvelope(event, label, "mainnet-beta", `del_${idx}`);
      const discord = formatDiscordEmbed(envelope);
      expect(discord.embeds).toHaveLength(1);
      expect(discord.embeds[0]?.url).toBe(envelope.explorerUrl);
      expect(discord.allowed_mentions).toEqual({ parse: [] });

      const html = formatTelegramHtml(envelope);
      expect(html).toContain("Open on Solscan");

      const webhookBody = formatWebhookPayload(envelope);
      expect(() => JSON.stringify(webhookBody)).not.toThrow();
      expect(webhookBody.event.kind).toBe(event.kind);
      expect(webhookBody.deliveryId).toBe(`del_${idx}`);

      const line = formatConsoleLine(envelope);
      expect(line).toContain(event.signature);
    }
  });

  it("neutralizes Discord Markdown phishing and strips ANSI escapes in terminal output", () => {
    const event = classifyParsedTransaction(makeProgramOnlyTx(), watched);
    const maliciousEvent =
      event.kind === "program_interaction"
        ? { ...event, summary: "\u001b[31mFake\u001b[0m > [Claim](https://evil.test)" }
        : event;
    const envelope = buildAlertEnvelope(
      maliciousEvent,
      "\u001b]0;Spoof\u0007[Wallet](https://evil.test)",
      "mainnet-beta",
      "del_md",
    );

    const discord = formatDiscordEmbed(envelope);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.embeds[0]?.description).toContain("\\[Claim\\]\\(https://evil.test\\)");
    expect(discord.embeds[0]?.fields[0]?.value).toContain("\\[Wallet\\]\\(https://evil.test\\)");

    const consoleCard = formatConsoleLine(envelope);
    expect(consoleCard).not.toContain("\u001b");
    expect(consoleCard).toContain("Fake");
  });

  it("renders USD valuations, source badges, swap color 0x9945ff, and v1.1 webhook fields", () => {
    const swapEvent = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const envelope = buildAlertEnvelope(swapEvent, "Alpha", "devnet", "del_v11", {
      estimatedUsd: 240.5,
      source: "backfill",
    });

    expect(envelope.summary).toContain("(~$240.50)");
    const html = formatTelegramHtml(envelope);
    expect(html).toContain("[BACKFILL]");
    expect(html).toContain("[DEVNET]");
    expect(html).toContain("solscan.io/account/");

    const discord = formatDiscordEmbed(envelope);
    expect(discord.embeds[0]?.color).toBe(0x9945ff);
    expect(discord.embeds[0]?.footer.text).toContain("BACKFILL");
    expect(discord.embeds[0]?.fields.some((f) => f.name === "Est. Value")).toBe(true);

    const payload = formatWebhookPayload(envelope);
    expect(payload.schemaVersion).toBe("1.1");
    expect(payload.source).toBe("backfill");
    expect(payload.estimatedUsd).toBe(240.5);
    expect("tokenIn" in payload.event ? payload.event.tokenIn.uiAmount : "").toBe("1.5");
    expect(formatConsoleLine(envelope)).toContain("[BACKFILL]");
  });
});
