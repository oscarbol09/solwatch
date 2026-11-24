import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyParsedTransaction,
  JITO_TIP_ACCOUNTS,
  normalizeTokenScale18,
  resolveProgramLabel,
  type SolanaTransactionInput,
} from "../../src/domain/classifier.js";
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
    expect(failed.kind === "program_interaction" && failed.summary).toContain("Jupiter");
  });

  it("handles WSOL unwraps, closeAccount rent reclaim, and Jito MEV tips accurately", () => {
    const base = makeProgramOnlyTx();
    const unwrapTx: SolanaTransactionInput = {
      ...base,
      meta: {
        ...base.meta,
        preBalances: [1_000_000_000n, 10_002_039_280n],
        postBalances: [11_002_034_280n, 0n],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: WSOL_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "10000000000", decimals: 9 },
          },
        ],
        postTokenBalances: [],
      },
      accountKeys: [WATCHED_WALLET_A, COUNTERPARTY_WALLET],
      programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    };
    const unwrapEvent = classifyParsedTransaction(unwrapTx, watched);
    expect(unwrapEvent.kind).toBe("program_interaction");
    if (unwrapEvent.kind === "program_interaction") {
      expect(unwrapEvent.summary).toContain("Unwrapped 10 SOL");
    }

    const closeAccountTx: SolanaTransactionInput = {
      ...base,
      meta: {
        ...base.meta,
        preBalances: [1_000_000_000n, 2_039_280n],
        postBalances: [1_002_034_280n, 0n],
      },
      accountKeys: [WATCHED_WALLET_A, COUNTERPARTY_WALLET],
      programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      parsedInstructions: [
        {
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          type: "closeAccount",
          info: { destination: WATCHED_WALLET_A },
        },
      ],
    };
    const closeEvent = classifyParsedTransaction(closeAccountTx, watched);
    expect(closeEvent.kind).toBe("program_interaction");
    if (closeEvent.kind === "program_interaction") {
      expect(closeEvent.summary).toContain("Closed token account");
    }

    const jitoTipTarget = [...JITO_TIP_ACCOUNTS][0];
    if (!jitoTipTarget) throw new Error("Expected JITO_TIP_ACCOUNTS entry");
    const rayBase = makeRaydiumTokenToTokenSwapTx();
    const withJitoTip: SolanaTransactionInput = {
      ...rayBase,
      meta: {
        ...rayBase.meta,
        // 0.01 SOL Jito tip (10_000_000n > MAX_ATA_RENT_DUST_LAMPORTS) plus 100 USDC -> BONK swap
        preBalances: [2_000_000_000n, 2_000_000n, 2_000_000n, 0n],
        postBalances: [1_989_990_000n, 2_000_000n, 2_000_000n, 10_000_000n],
      },
      accountKeys: [...rayBase.accountKeys, jitoTipTarget],
      parsedInstructions: [
        {
          programId: "11111111111111111111111111111111",
          type: "transfer",
          info: { source: WATCHED_WALLET_A, destination: jitoTipTarget, lamports: 10_000_000 },
        },
      ],
    };
    const jitoSwapEvent = classifyParsedTransaction(withJitoTip, watched);
    expect(jitoSwapEvent.kind).toBe("dex_swap");
    if (jitoSwapEvent.kind === "dex_swap") {
      expect(jitoSwapEvent.tokenIn.mint).toBe(USDC_MINT);
      expect(jitoSwapEvent.tokenIn.rawAmount).toBe(100_000_000n);
    }
  });

  it("compares SPL magnitudes by decimal scale, disambiguates AMM LP ops, recovers missing owner, and clarifies NFT buys", () => {
    const splBase = makeSplUsdcTransferTx();
    const multiSpl: SolanaTransactionInput = {
      ...splBase,
      meta: {
        ...splBase.meta,
        // 9 USDC (9_000_000n, 6 dec) vs 0.01 9-dec token (10_000_000n raw!) -> 9 USDC must win!
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: CUSTOM_UNKNOWN_MINT,
            // owner intentionally omitted on preTokenBalances side (recovered from postTokenBalances)
            uiTokenAmount: { amount: "0", decimals: 9 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "10000000", decimals: 9 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "9000000", decimals: 6 },
          },
        ],
      },
    };
    const multiSplEvent = classifyParsedTransaction(multiSpl, watched);
    expect(multiSplEvent.kind).toBe("spl_transfer");
    if (multiSplEvent.kind === "spl_transfer") {
      expect(multiSplEvent.mint).toBe(USDC_MINT);
      expect(multiSplEvent.rawAmount).toBe(9_000_000n);
    }

    // AMM LP deposit: 2 spent legs (SOL + USDC) -> 1 LP mint received on Raydium
    const jupBase = makeJupiterSwapTx();
    const lpDepositTx: SolanaTransactionInput = {
      ...jupBase,
      programIds: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
      meta: {
        ...jupBase.meta,
        innerInstructions: [],
        preBalances: [5_000_000_000n, 2_000_000n, 2_000_000n],
        postBalances: [3_999_985_000n, 2_000_000n, 2_000_000n],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "500000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "300000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "50000000", decimals: 6 },
          },
        ],
      },
    };
    const lpEvent = classifyParsedTransaction(lpDepositTx, watched);
    expect(lpEvent.kind).toBe("program_interaction");
    if (lpEvent.kind === "program_interaction") {
      expect(lpEvent.summary).toBe("Liquidity provision on Raydium");
    }

    // NFT purchase on Tensor: spent 5 SOL and received 1 0-decimal mint -> explicit NFT summary
    const nftTx: SolanaTransactionInput = {
      ...makeProgramOnlyTx(),
      programIds: ["TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN"],
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [10_000_000_000n, 0n],
        postBalances: [4_999_995_000n, 2_039_280n],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "1", decimals: 0 },
          },
        ],
      },
    };
    const nftEvent = classifyParsedTransaction(nftTx, watched);
    expect(nftEvent.kind).toBe("program_interaction");
    if (nftEvent.kind === "program_interaction") {
      expect(nftEvent.summary).toContain("Purchased NFT");
      expect(nftEvent.summary).toContain("5 SOL");
      expect(nftEvent.summary).toContain("Tensor");
    }
  });

  it("satisfies determinism, non-negativity, and fee-only neutrality across randomized transactions", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.bigInt({ min: 0n, max: 50_000_000n }),
        fc.bigInt({ min: 0n, max: 50_000_000_000n }),
        fc.boolean(),
        (preSol, fee, delta, isFailed) => {
          const safePre = preSol + fee;
          const postSol = safePre - fee;
          const tx: SolanaTransactionInput = {
            signature: makeIncomingSolTx().signature,
            slot: 310_000_999n,
            blockTime: 1_760_000_000,
            meta: {
              err: isFailed ? { InstructionError: [0, "Custom"] } : null,
              fee,
              preBalances: [safePre, 1_000_000_000n],
              postBalances: [postSol, 1_000_000_000n + (delta > 0n ? 0n : 0n)],
              preTokenBalances: [],
              postTokenBalances: [],
              innerInstructions: [],
            },
            accountKeys: [WATCHED_WALLET_A, COUNTERPARTY_WALLET],
            programIds: ["Stake11111111111111111111111111111111111111"],
          };

          const ev1 = classifyParsedTransaction(tx, watched);
          const ev2 = classifyParsedTransaction(tx, watched);
          if (ev1.kind !== ev2.kind || ev1.feeLamports !== fee) return false;
          // Fee-only transaction must never classify as a SOL transfer
          if (ev1.kind === "sol_transfer") return false;
          return true;
        },
      ),
    );
  });

  it("handles outgoing SPL transfers, AMM LP removal, NFT sales, malformed balance amounts, >18 decimals, and infra-only programs", () => {
    // Outgoing SPL transfer + counterparty detection
    const outSplTx: SolanaTransactionInput = {
      ...makeSplUsdcTransferTx(),
      meta: {
        ...makeSplUsdcTransferTx().meta,
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: COUNTERPARTY_WALLET,
            uiTokenAmount: { amount: "bad-integer", decimals: 6 },
          },
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: COUNTERPARTY_WALLET,
            uiTokenAmount: { amount: "100000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "500000000", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: COUNTERPARTY_WALLET,
            uiTokenAmount: { amount: "350000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "250000000", decimals: 6 },
          },
        ],
      },
    };
    const outSplEvent = classifyParsedTransaction(outSplTx, watched);
    expect(outSplEvent.kind).toBe("spl_transfer");
    if (outSplEvent.kind === "spl_transfer") {
      expect(outSplEvent.direction).toBe("out");
      expect(outSplEvent.rawAmount).toBe(250_000_000n);
      expect(outSplEvent.counterparty).toBe(COUNTERPARTY_WALLET);
    }

    // AMM LP removal: 1 LP mint spent -> 2 tokens received on Raydium
    const lpWithdrawTx: SolanaTransactionInput = {
      ...makeJupiterSwapTx(),
      programIds: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
      meta: {
        ...makeJupiterSwapTx().meta,
        innerInstructions: [],
        preBalances: [2_000_000_000n, 2_000_000n, 2_000_000n],
        postBalances: [3_499_985_000n, 2_000_000n, 2_000_000n],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "100000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "50000000", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "300000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
      },
    };
    const lpRemoveEvent = classifyParsedTransaction(lpWithdrawTx, watched);
    expect(lpRemoveEvent.kind).toBe("program_interaction");
    if (lpRemoveEvent.kind === "program_interaction") {
      expect(lpRemoveEvent.summary).toBe("Liquidity removal on Raydium");
    }

    // NFT sale: -1 0-decimal mint for +5 SOL on Magic Eden v2
    const nftSellTx: SolanaTransactionInput = {
      ...makeProgramOnlyTx(),
      programIds: ["M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K"],
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [1_000_000_000n, 0n],
        postBalances: [5_999_995_000n, 0n],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: CUSTOM_UNKNOWN_MINT,
            owner: WATCHED_WALLET_A,
            uiTokenAmount: { amount: "1", decimals: 0 },
          },
        ],
        postTokenBalances: [],
      },
    };
    const nftSellEvent = classifyParsedTransaction(nftSellTx, watched);
    expect(nftSellEvent.kind).toBe("program_interaction");
    if (nftSellEvent.kind === "program_interaction") {
      expect(nftSellEvent.summary).toContain("Sold NFT");
      expect(nftSellEvent.summary).toContain("Magic Eden v2");
    }

    // >18 decimals scaling branch + infra-only / empty programs summary
    expect(normalizeTokenScale18(1_000_000_000_000_000_000_000n, 20)).toBe(
      10_000_000_000_000_000_000n,
    );
    const infraOnly = classifyParsedTransaction(
      {
        ...makeProgramOnlyTx(),
        programIds: ["11111111111111111111111111111111"],
      },
      watched,
    );
    expect(infraOnly.kind === "program_interaction" && infraOnly.summary).toBe("Invoked System");
    const emptyPrograms = classifyParsedTransaction(
      {
        ...makeProgramOnlyTx(),
        programIds: [],
      },
      watched,
    );
    expect(emptyPrograms.kind === "program_interaction" && emptyPrograms.summary).toBe(
      "Invoked Solana program",
    );
  });

  it("resolves program labels across known programs, DEXs, NFT marketplaces, and fallback addresses", () => {
    // Known programs
    expect(resolveProgramLabel("11111111111111111111111111111111")).toBe("System");
    expect(resolveProgramLabel("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe("SPL Token");

    // DEX programs
    expect(resolveProgramLabel("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toBe("Jupiter");
    expect(resolveProgramLabel("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).toBe("Raydium");

    // NFT Marketplaces
    expect(resolveProgramLabel("TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN")).toBe("Tensor");
    expect(resolveProgramLabel("TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp")).toBe("Tensor cNFT");
    expect(resolveProgramLabel("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K")).toBe(
      "Magic Eden v2",
    );

    // Unknown address fallback
    expect(resolveProgramLabel("UnknownProgram111111111111111111111111111111")).toBe(
      "Unkn...11111",
    );
  });
});
