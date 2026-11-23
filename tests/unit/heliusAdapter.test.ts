import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors.js";
import { USDC_MINT, WSOL_MINT } from "../../src/domain/tokens.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import { parseHeliusWebhookPayload } from "../../src/solana/heliusAdapter.js";
import {
  HELIUS_WEBHOOK_FIXTURE,
  SIG_FAILED_TX,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const watched = parseWalletAddress(WATCHED_WALLET_A);

describe("parseHeliusWebhookPayload", () => {
  it("normalizes Helius SWAP, native TRANSFER, and SPL TRANSFER events for watched wallets", () => {
    const events = parseHeliusWebhookPayload(HELIUS_WEBHOOK_FIXTURE, new Set([watched]));
    expect(events).toHaveLength(3);

    const swap = events[0];
    expect(swap?.kind).toBe("dex_swap");
    if (swap?.kind !== "dex_swap") throw new Error("expected dex_swap");
    expect(swap.dex).toBe("JUPITER");
    expect(swap.tokenIn.mint).toBe(WSOL_MINT);
    expect(swap.tokenIn.rawAmount).toBe(1_500_000_000n);
    expect(swap.tokenOut.mint).toBe(USDC_MINT);
    expect(swap.tokenOut.rawAmount).toBe(240_000_000n);

    const solIn = events[1];
    expect(solIn?.kind).toBe("sol_transfer");
    if (solIn?.kind !== "sol_transfer") throw new Error("expected sol_transfer");
    expect(solIn.direction).toBe("in");
    expect(solIn.lamports).toBe(2_500_000_000n);

    const splIn = events[2];
    expect(splIn?.kind).toBe("spl_transfer");
    if (splIn?.kind !== "spl_transfer") throw new Error("expected spl_transfer");
    expect(splIn.direction).toBe("in");
    expect(splIn.rawAmount).toBe(1_250_500_000n);
  });

  it("skips transactions involving no watched wallets and marks failed txs", () => {
    const otherWatched = parseWalletAddress("11111111111111111111111111111111");
    expect(parseHeliusWebhookPayload(HELIUS_WEBHOOK_FIXTURE, new Set([otherWatched]))).toEqual([]);

    const failedEvents = parseHeliusWebhookPayload(
      [
        {
          signature: SIG_FAILED_TX,
          slot: 100,
          timestamp: 1_760_000_000,
          fee: 5_000,
          feePayer: WATCHED_WALLET_A,
          type: "UNKNOWN",
          source: "JUPITER",
          transactionError: { InstructionError: [0, "Custom"] },
        },
      ],
      new Set([watched]),
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.success).toBe(false);
    expect(failedEvents[0]?.kind).toBe("program_interaction");
  });

  it("throws ValidationError on malformed webhook payload", () => {
    expect(() => parseHeliusWebhookPayload({ invalid: true }, new Set([watched]))).toThrow(
      ValidationError,
    );
  });
});
