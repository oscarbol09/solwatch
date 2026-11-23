import { describe, expect, it } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { BONK_MINT, USDC_MINT, WSOL_MINT } from "../../src/domain/tokens.js";
import { parseWalletAddress } from "../../src/domain/types.js";
import {
  COUNTERPARTY_WALLET,
  CUSTOM_UNKNOWN_MINT,
  makeFailedTx,
  makeIncomingSolTx,
  makeJupiterSwapTx,
  makeOutgoingSolTx,
  makeProgramOnlyTx,
  makeRaydiumTokenToTokenSwapTx,
  makeSplUsdcTransferTx,
  makeToken2022DustTx,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const watched = parseWalletAddress(WATCHED_WALLET_A);

describe("classifyParsedTransaction", () => {
  it("classifies incoming native SOL transfer accurately", () => {
    const event = classifyParsedTransaction(makeIncomingSolTx(), watched);
    expect(event.kind).toBe("sol_transfer");
    if (event.kind !== "sol_transfer") throw new Error("unexpected kind");
    expect(event.direction).toBe("in");
    expect(event.lamports).toBe(2_500_000_000n);
    expect(event.counterparty).toBe(COUNTERPARTY_WALLET);
    expect(event.success).toBe(true);
  });

  it("classifies outgoing native SOL transfer net of transaction fee", () => {
    const event = classifyParsedTransaction(makeOutgoingSolTx(), watched);
    expect(event.kind).toBe("sol_transfer");
    if (event.kind !== "sol_transfer") throw new Error("unexpected kind");
    expect(event.direction).toBe("out");
    expect(event.lamports).toBe(1_500_000_000n);
    expect(event.feeLamports).toBe(5_000n);
    expect(event.counterparty).toBe(COUNTERPARTY_WALLET);
  });

  it("classifies SPL USDC token transfer with counterparty detection", () => {
    const event = classifyParsedTransaction(makeSplUsdcTransferTx(), watched);
    expect(event.kind).toBe("spl_transfer");
    if (event.kind !== "spl_transfer") throw new Error("unexpected kind");
    expect(event.direction).toBe("in");
    expect(event.mint).toBe(USDC_MINT);
    expect(event.symbol).toBe("USDC");
    expect(event.rawAmount).toBe(1_250_000_000n);
    expect(event.decimals).toBe(6);
    expect(event.counterparty).toBe(COUNTERPARTY_WALLET);
  });

  it("classifies Token-2022 unknown mint using fallback symbol", () => {
    const event = classifyParsedTransaction(makeToken2022DustTx(), watched);
    expect(event.kind).toBe("spl_transfer");
    if (event.kind !== "spl_transfer") throw new Error("unexpected kind");
    expect(event.mint).toBe(CUSTOM_UNKNOWN_MINT);
    expect(event.symbol).toBe("4k3D...rkX6R");
    expect(event.rawAmount).toBe(1_000_000n);
    expect(event.decimals).toBe(9);
  });

  it("classifies Jupiter v6 SOL->USDC swap prioritizing Jupiter over inner Raydium CPI", () => {
    const event = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    expect(event.kind).toBe("dex_swap");
    if (event.kind !== "dex_swap") throw new Error("unexpected kind");
    expect(event.dex).toBe("Jupiter");
    expect(event.tokenIn.mint).toBe(WSOL_MINT);
    expect(event.tokenIn.symbol).toBe("SOL");
    expect(event.tokenIn.rawAmount).toBe(1_500_000_000n);
    expect(event.tokenOut.mint).toBe(USDC_MINT);
    expect(event.tokenOut.symbol).toBe("USDC");
    expect(event.tokenOut.rawAmount).toBe(240_000_000n);
  });

  it("classifies Raydium USDC->BONK swap cleanly", () => {
    const event = classifyParsedTransaction(makeRaydiumTokenToTokenSwapTx(), watched);
    expect(event.kind).toBe("dex_swap");
    if (event.kind !== "dex_swap") throw new Error("unexpected kind");
    expect(event.dex).toBe("Raydium");
    expect(event.tokenIn.mint).toBe(USDC_MINT);
    expect(event.tokenIn.rawAmount).toBe(100_000_000n);
    expect(event.tokenOut.mint).toBe(BONK_MINT);
    expect(event.tokenOut.rawAmount).toBe(45_000_000_000n);
  });

  it("prioritizes real SPL swap input over small ATA rent SOL dust", () => {
    const base = makeRaydiumTokenToTokenSwapTx();
    const withAtaRent = {
      ...base,
      meta: {
        ...base.meta,
        // Wallet spent 1.5 USDC (1_500_000n) and 0.00203928 SOL (2_039_280n) ATA rent
        preBalances: [2_000_000_000n, 2_000_000n, 2_000_000n],
        postBalances: [1_997_950_720n, 2_000_000n, 2_000_000n],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "5000000", decimals: 6 },
          },
          ...(base.meta.preTokenBalances?.slice(1) ?? []),
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "3500000", decimals: 6 },
          },
          ...(base.meta.postTokenBalances?.slice(1) ?? []),
        ],
      },
    };

    const event = classifyParsedTransaction(withAtaRent, watched);
    expect(event.kind).toBe("dex_swap");
    if (event.kind !== "dex_swap") throw new Error("unexpected kind");
    expect(event.tokenIn.mint).toBe(USDC_MINT);
    expect(event.tokenIn.rawAmount).toBe(1_500_000n);
  });

  it("does not misclassify fee-only program calls or failed transactions as SOL transfers", () => {
    const failed = classifyParsedTransaction(makeFailedTx(), watched);
    expect(failed.kind).toBe("program_interaction");
    expect(failed.success).toBe(false);

    const prog = classifyParsedTransaction(makeProgramOnlyTx(), watched);
    expect(prog.kind).toBe("program_interaction");
    if (prog.kind !== "program_interaction") throw new Error("unexpected kind");
    expect(prog.success).toBe(true);
    expect(prog.programIds).toContain("Stake11111111111111111111111111111111111111");
    expect(prog.summary).not.toContain("ComputeBudget");
  });
});
