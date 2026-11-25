import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyParsedTransaction,
  type SolanaTransactionInput,
} from "../../src/domain/classifier.js";
import { ValidationError } from "../../src/domain/errors.js";
import {
  formatGroupedInteger,
  formatLamportsAsSol,
  parseSolToLamports,
} from "../../src/domain/tokens.js";
import { parseTxSignature, parseWalletAddress } from "../../src/domain/types.js";
import {
  parseHeliusWebhookBatch,
  parseHeliusWebhookPayload,
} from "../../src/solana/heliusAdapter.js";
import { SIG_SOL_IN, WATCHED_WALLET_A } from "../fixtures/solanaTransactions.js";

describe("Property-Based Testing & Fuzzing (fast-check)", () => {
  const targetWallet = parseWalletAddress(WATCHED_WALLET_A);
  const targetSig = parseTxSignature(SIG_SOL_IN);

  it("invariant: parseSolToLamports and formatLamportsAsSol are mathematical inverses", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 999_999_999 }),
        (wholeSol, fractionLamports) => {
          const fracStr = fractionLamports.toString().padStart(9, "0");
          const solString = `${wholeSol}.${fracStr}`;
          const parsed = parseSolToLamports(solString);

          const expectedLamports = BigInt(wholeSol) * 1_000_000_000n + BigInt(fractionLamports);
          expect(parsed).toBe(expectedLamports);

          // With maxFractionDigits = 9, formatLamportsAsSol preserves all 9 fractional digits exactly
          const formatted = formatLamportsAsSol(parsed, 9);
          const roundTrip = parseSolToLamports(formatted);
          expect(roundTrip).toBe(parsed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("invariant: formatGroupedInteger places comma separators every 3 digits", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (val) => {
        const str = formatGroupedInteger(val.toString());
        const unformatted = BigInt(str.replace(/,/g, ""));
        expect(unformatted).toBe(val);

        const parts = str.split(",");
        for (let i = 1; i < parts.length; i += 1) {
          expect(parts[i]?.length).toBe(3);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("invariant: classifyParsedTransaction never throws and preserves wallet identity", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        fc.boolean(),
        (preBal, postBal, fee, isSuccess) => {
          const txInput: SolanaTransactionInput = {
            signature: targetSig,
            slot: 310_000_000n,
            blockTime: 1_760_000_000,
            accountKeys: [targetWallet],
            programIds: [],
            meta: {
              err: isSuccess ? null : { InstructionError: [0, "Custom"] },
              fee,
              preBalances: [preBal],
              postBalances: [postBal],
              preTokenBalances: [],
              postTokenBalances: [],
              innerInstructions: [],
            },
          };

          const event = classifyParsedTransaction(txInput, targetWallet);
          expect(event).toBeDefined();
          expect(event.wallet).toBe(targetWallet);
          expect(event.signature).toBe(targetSig);
          expect(event.success).toBe(isSuccess);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("invariant: parseHeliusWebhookPayload never throws uncaught exceptions on arbitrary inputs", () => {
    const watchedSet = new Set([targetWallet]);

    fc.assert(
      fc.property(fc.anything(), (corruptedInput) => {
        try {
          const events = parseHeliusWebhookPayload(corruptedInput, watchedSet);
          expect(Array.isArray(events)).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
        }

        try {
          const batch = parseHeliusWebhookBatch(corruptedInput, watchedSet);
          expect(Array.isArray(batch.events)).toBe(true);
          expect(typeof batch.skippedInvalid).toBe("number");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
        }
      }),
      { numRuns: 100 },
    );
  });
});
