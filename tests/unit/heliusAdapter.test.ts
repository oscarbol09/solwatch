import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors.js";
import { USDC_MINT, WSOL_MINT } from "../../src/domain/tokens.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import {
  parseHeliusWebhookBatch,
  parseHeliusWebhookPayload,
} from "../../src/solana/heliusAdapter.js";
import {
  COUNTERPARTY_WALLET,
  CUSTOM_UNKNOWN_MINT,
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

  it("throws ValidationError on malformed webhook payload or non-integer swap amounts", () => {
    expect(() => parseHeliusWebhookPayload({ invalid: true }, new Set([watched]))).toThrow(
      ValidationError,
    );

    expect(() =>
      parseHeliusWebhookPayload(
        [
          {
            signature: SIG_FAILED_TX,
            slot: 100,
            type: "SWAP",
            feePayer: WATCHED_WALLET_A,
            events: {
              swap: {
                nativeInput: { account: WATCHED_WALLET_A, amount: "1.5" },
              },
            },
          },
        ],
        new Set([watched]),
      ),
    ).toThrow(ValidationError);

    expect(() =>
      parseHeliusWebhookPayload(
        [
          {
            signature: SIG_FAILED_TX,
            slot: 100,
            type: "SWAP",
            feePayer: WATCHED_WALLET_A,
            events: {
              swap: {
                tokenInputs: [
                  {
                    userAccount: WATCHED_WALLET_A,
                    mint: USDC_MINT,
                    rawTokenAmount: { tokenAmount: "100", decimals: 99 },
                  },
                ],
              },
            },
          },
        ],
        new Set([watched]),
      ),
    ).toThrow(ValidationError);
  });

  it("checks swap ownership and skips zero-amount token transfers", () => {
    const counterparty = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRJe";
    const watchedCounterparty = parseWalletAddress(counterparty);

    const events = parseHeliusWebhookPayload(
      [
        {
          signature: SIG_FAILED_TX,
          slot: 200,
          timestamp: 1_760_000_000,
          fee: 5_000,
          feePayer: counterparty,
          type: "SWAP",
          source: "JUPITER",
          nativeTransfers: [
            { fromUserAccount: counterparty, toUserAccount: WATCHED_WALLET_A, amount: 500_000_000 },
          ],
          tokenTransfers: [
            {
              fromUserAccount: counterparty,
              toUserAccount: WATCHED_WALLET_A,
              mint: USDC_MINT,
              tokenAmount: 0,
            },
          ],
          events: {
            swap: {
              nativeInput: { account: WATCHED_WALLET_A, amount: "1500000000" },
              tokenOutputs: [
                {
                  userAccount: WATCHED_WALLET_A,
                  mint: USDC_MINT,
                  rawTokenAmount: { tokenAmount: "240000000", decimals: 6 },
                },
              ],
            },
          },
        },
      ],
      new Set([watched, watchedCounterparty]),
    );

    const forSwapper = events.find((e) => e.wallet === watched);
    const forOther = events.find((e) => e.wallet === watchedCounterparty);
    expect(forSwapper?.kind).toBe("dex_swap");
    // Counterparty who did NOT own the swap gets its actual SOL transfer instead of a phantom swap
    expect(forOther?.kind).toBe("sol_transfer");
  });

  it("picks largest native/token transfer over initial rent rows, skips sub-unit 1e-12 dust, accepts nullable Helius fields, quarantines bad batch items, and rejects oversized integer strings", () => {
    // 1. First transfer is 0.002039 SOL ATA rent, second is 500 SOL -> 500 SOL must win!
    // 2. 1e-12 unknown token rounds to 0 base units -> safely skipped instead of emitting zero SPL transfer!
    const complexPayload = [
      {
        signature: SIG_FAILED_TX,
        slot: 300,
        timestamp: null,
        fee: null,
        feePayer: WATCHED_WALLET_A,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        transactionError: null,
        nativeTransfers: [
          {
            fromUserAccount: WATCHED_WALLET_A,
            toUserAccount: "11111111111111111111111111111111",
            amount: 2_039_280,
          },
          {
            fromUserAccount: COUNTERPARTY_WALLET,
            toUserAccount: WATCHED_WALLET_A,
            amount: 500_000_000_000,
          },
        ],
        tokenTransfers: [
          {
            fromUserAccount: COUNTERPARTY_WALLET,
            toUserAccount: WATCHED_WALLET_A,
            mint: CUSTOM_UNKNOWN_MINT,
            tokenAmount: 1e-12,
          },
        ],
        events: { swap: null },
      },
      { signature: "bad", slot: "oops" },
    ];

    const batch = parseHeliusWebhookBatch(complexPayload, new Set([watched]));
    expect(batch.skippedInvalid).toBe(1);
    expect(batch.events).toHaveLength(1);
    const mainSol = batch.events[0];
    expect(mainSol?.kind).toBe("sol_transfer");
    if (mainSol?.kind === "sol_transfer") {
      expect(mainSol.lamports).toBe(500_000_000_000n);
      expect(mainSol.direction).toBe("in");
    }

    // 500-digit BigInt DoS payload rejected cleanly
    expect(() =>
      parseHeliusWebhookPayload(
        [
          {
            signature: SIG_FAILED_TX,
            slot: 100,
            type: "SWAP",
            feePayer: WATCHED_WALLET_A,
            events: { swap: { nativeInput: { amount: "9".repeat(500) } } },
          },
        ],
        new Set([watched]),
      ),
    ).toThrow(ValidationError);

    // Property fuzzing: arbitrary JSON inputs never trigger uncaught TypeError/RangeError
    fc.assert(
      fc.property(fc.jsonValue(), (arbitraryJson) => {
        try {
          parseHeliusWebhookBatch(arbitraryJson, new Set([watched]));
          return true;
        } catch (err) {
          return err instanceof ValidationError;
        }
      }),
    );

    // Covers tokenInputs + nativeOutput multi-leg swap, feePayer-only ownership, outgoing SPL, outgoing SOL, program_interaction, non-array validation, and invalid Base58 quarantine
    expect(() => parseHeliusWebhookBatch({ not: "an-array" }, new Set([watched]))).toThrow(
      ValidationError,
    );

    const diverseBatch = parseHeliusWebhookBatch(
      [
        {
          signature: "bad-base58-sig",
          slot: 10,
          feePayer: WATCHED_WALLET_A,
        },
        {
          signature: SIG_FAILED_TX,
          slot: 400,
          type: "SWAP",
          source: "RAYDIUM",
          feePayer: WATCHED_WALLET_A,
          events: {
            swap: {
              tokenInputs: [
                {
                  mint: USDC_MINT,
                  rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
                },
                {
                  mint: USDC_MINT,
                  rawTokenAmount: { tokenAmount: "2000000", decimals: 6 },
                },
              ],
              nativeOutput: { amount: "500000000" },
            },
          },
        },
        {
          signature: SIG_FAILED_TX,
          slot: 401,
          type: "TRANSFER",
          source: "SPL_TOKEN",
          feePayer: WATCHED_WALLET_A,
          tokenTransfers: [
            {
              fromUserAccount: WATCHED_WALLET_A,
              toUserAccount: COUNTERPARTY_WALLET,
              mint: USDC_MINT,
              tokenAmount: 25,
            },
          ],
        },
        {
          signature: SIG_FAILED_TX,
          slot: 402,
          type: "TRANSFER",
          source: "SYSTEM_PROGRAM",
          feePayer: WATCHED_WALLET_A,
          nativeTransfers: [
            {
              fromUserAccount: WATCHED_WALLET_A,
              toUserAccount: COUNTERPARTY_WALLET,
              amount: 250_000_000,
            },
          ],
        },
        {
          signature: SIG_FAILED_TX,
          slot: 403,
          type: "VOTE",
          source: "SOLANA_PROGRAM",
          feePayer: WATCHED_WALLET_A,
          description: "Cast governance vote",
        },
      ],
      new Set([watched]),
    );

    expect(diverseBatch.skippedInvalid).toBe(1);
    expect(diverseBatch.events).toHaveLength(4);
    expect(diverseBatch.events[0]?.kind).toBe("dex_swap");
    if (diverseBatch.events[0]?.kind === "dex_swap") {
      expect(diverseBatch.events[0].tokenIn.rawAmount).toBe(3_000_000n);
      expect(diverseBatch.events[0].tokenOut.mint).toBe(WSOL_MINT);
    }
    expect(diverseBatch.events[1]?.kind).toBe("spl_transfer");
    if (diverseBatch.events[1]?.kind === "spl_transfer") {
      expect(diverseBatch.events[1].direction).toBe("out");
    }
    expect(diverseBatch.events[2]?.kind).toBe("sol_transfer");
    if (diverseBatch.events[2]?.kind === "sol_transfer") {
      expect(diverseBatch.events[2].direction).toBe("out");
    }
    expect(diverseBatch.events[3]?.kind).toBe("program_interaction");
  });
});
