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
});
