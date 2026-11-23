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
    const envelope = buildAlertEnvelope(event, "<Treasury & Ops>", "devnet", "deliv_1");
    const html = formatTelegramHtml(envelope);

    expect(html).toContain("&lt;Treasury &amp; Ops&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("+2.5 SOL");
    expect(html).toContain("?cluster=devnet");
  });

  it("formats Discord embeds, JSON-safe webhook payloads, and terminal cards across all event kinds", () => {
    const events = [
      classifyParsedTransaction(makeIncomingSolTx(), watched),
      classifyParsedTransaction(makeSplUsdcTransferTx(), watched),
      classifyParsedTransaction(makeJupiterSwapTx(), watched),
      classifyParsedTransaction(makeFailedTx(), watched),
    ];

    for (const [idx, event] of events.entries()) {
      const envelope = buildAlertEnvelope(event, "Main Wallet", "mainnet-beta", `del_${idx}`);
      const discord = formatDiscordEmbed(envelope);
      expect(discord.embeds).toHaveLength(1);
      expect(discord.embeds[0]?.url).toBe(envelope.explorerUrl);

      const webhookBody = formatWebhookPayload(envelope);
      expect(() => JSON.stringify(webhookBody)).not.toThrow();
      expect(webhookBody.event.kind).toBe(event.kind);
      expect(webhookBody.deliveryId).toBe(`del_${idx}`);

      const line = formatConsoleLine(envelope);
      expect(line).toContain("Main Wallet");
      expect(line).toContain(event.signature);
    }
  });
});
