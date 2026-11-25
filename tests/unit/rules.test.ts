import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { CooldownTracker, evaluateAlertRules } from "../../src/domain/rules.js";
import { BONK_MINT, LAMPORTS_PER_SOL, USDC_MINT } from "../../src/domain/tokens.js";
import {
  type AlertRule,
  type OnChainEvent,
  parseMintAddress,
  parseRuleId,
  parseWalletAddress,
} from "../../src/domain/types.js";
import {
  CUSTOM_UNKNOWN_MINT,
  makeFailedTx,
  makeIncomingSolTx,
  makeJupiterSwapTx,
  makeProgramOnlyTx,
  makeRaydiumTokenToTokenSwapTx,
  makeSplUsdcTransferTx,
  makeToken2022DustTx,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const watched = parseWalletAddress(WATCHED_WALLET_A);
const otherWallet = parseWalletAddress("GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRJe");

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: parseRuleId("global-default"),
    walletAddress: null,
    minSolLamports: 100_000_000n,
    eventTypes: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"],
    mintAllowlist: [],
    mintDenylist: [],
    includeFailed: false,
    cooldownSeconds: 0,
    enabled: true,
    ...overrides,
  };
}

describe("alert rules engine and cooldowns", () => {
  it("filters SOL transfers against minSolLamports threshold", () => {
    const tracker = new CooldownTracker();
    const solIn = classifyParsedTransaction(makeIncomingSolTx(), watched); // 2.5 SOL
    const highThreshold = makeRule({ minSolLamports: 5n * LAMPORTS_PER_SOL });
    const lowThreshold = makeRule({ minSolLamports: 1n * LAMPORTS_PER_SOL });

    expect(evaluateAlertRules(solIn, [highThreshold], tracker, 1_000).matched).toBe(false);
    expect(evaluateAlertRules(solIn, [lowThreshold], tracker, 1_000).matched).toBe(true);
  });

  it("checks WSOL swap leg against minSolLamports while letting token-only swaps pass", () => {
    const tracker = new CooldownTracker();
    const jupSwap = classifyParsedTransaction(makeJupiterSwapTx(), watched); // 1.5 SOL -> 240 USDC
    const raySwap = classifyParsedTransaction(makeRaydiumTokenToTokenSwapTx(), watched); // USDC -> BONK

    const minTwoSol = makeRule({ minSolLamports: 2n * LAMPORTS_PER_SOL });
    expect(evaluateAlertRules(jupSwap, [minTwoSol], tracker, 1_000).matched).toBe(false);
    expect(evaluateAlertRules(raySwap, [minTwoSol], tracker, 1_000).matched).toBe(true);
  });

  it("enforces mintDenylist and mintAllowlist on SPL transfers and DEX swaps", () => {
    const tracker = new CooldownTracker();
    const spamMint = parseMintAddress(CUSTOM_UNKNOWN_MINT);
    const dustTx = classifyParsedTransaction(makeToken2022DustTx(), watched);
    const usdcTx = classifyParsedTransaction(makeSplUsdcTransferTx(), watched);
    const raySwap = classifyParsedTransaction(makeRaydiumTokenToTokenSwapTx(), watched);

    const denySpam = makeRule({ mintDenylist: [spamMint] });
    expect(evaluateAlertRules(dustTx, [denySpam], tracker, 1_000).matched).toBe(false);
    expect(evaluateAlertRules(usdcTx, [denySpam], tracker, 1_000).matched).toBe(true);

    const onlyUsdcOrBonk = makeRule({ mintAllowlist: [USDC_MINT] });
    expect(evaluateAlertRules(dustTx, [onlyUsdcOrBonk], tracker, 1_000).matched).toBe(false);
    expect(evaluateAlertRules(usdcTx, [onlyUsdcOrBonk], tracker, 1_000).matched).toBe(true);
    expect(evaluateAlertRules(raySwap, [onlyUsdcOrBonk], tracker, 1_000).matched).toBe(true);

    const denyBonk = makeRule({ mintDenylist: [BONK_MINT] });
    expect(evaluateAlertRules(raySwap, [denyBonk], tracker, 1_000).matched).toBe(false);
  });

  it("suppresses failed transactions unless includeFailed is enabled", () => {
    const tracker = new CooldownTracker();
    const failed = classifyParsedTransaction(makeFailedTx(), watched);
    expect(
      evaluateAlertRules(failed, [makeRule({ includeFailed: false })], tracker, 1_000).matched,
    ).toBe(false);
    expect(
      evaluateAlertRules(failed, [makeRule({ includeFailed: true })], tracker, 1_000).matched,
    ).toBe(true);
  });

  it("filters by eventTypes and gives wallet-specific rules precedence over global rules", () => {
    const tracker = new CooldownTracker();
    const prog = classifyParsedTransaction(makeProgramOnlyTx(), watched);
    const solIn = classifyParsedTransaction(makeIncomingSolTx(), watched);

    const globalRule = makeRule({
      id: parseRuleId("global"),
      minSolLamports: 100_000_000n,
      eventTypes: ["sol_transfer", "spl_transfer", "dex_swap"],
    });
    const walletSpecific = makeRule({
      id: parseRuleId("wallet-override"),
      walletAddress: watched,
      minSolLamports: 10n * LAMPORTS_PER_SOL,
      eventTypes: ["sol_transfer", "program_interaction"],
    });
    const unrelatedWalletRule = makeRule({
      id: parseRuleId("other-wallet"),
      walletAddress: otherWallet,
      minSolLamports: 0n,
    });

    // Wallet-specific override raises SOL threshold to 10 SOL for `watched`, overriding 0.1 SOL global.
    expect(
      evaluateAlertRules(solIn, [globalRule, walletSpecific, unrelatedWalletRule], tracker, 1_000)
        .matched,
    ).toBe(false);
    // Wallet-specific override explicitly enables program_interaction for `watched`.
    const progResult = evaluateAlertRules(
      prog,
      [globalRule, walletSpecific, unrelatedWalletRule],
      tracker,
      1_000,
    );
    expect(progResult.matched).toBe(true);
    expect(progResult.matchedRuleId).toBe(parseRuleId("wallet-override"));
  });

  it("enforces per-wallet and per-event-type cooldown windows cleanly", () => {
    const tracker = new CooldownTracker();
    const rule = makeRule({ cooldownSeconds: 60 });
    const solIn = classifyParsedTransaction(makeIncomingSolTx(), watched);
    const usdcIn = classifyParsedTransaction(makeSplUsdcTransferTx(), watched);

    expect(evaluateAlertRules(solIn, [rule], tracker, 10_000).matched).toBe(true);
    tracker.record(solIn.wallet, solIn.kind, 10_000);

    // Same wallet + same event type within 60s -> blocked
    expect(evaluateAlertRules(solIn, [rule], tracker, 45_000).matched).toBe(false);
    // Different event type on same wallet -> allowed
    expect(evaluateAlertRules(usdcIn, [rule], tracker, 45_000).matched).toBe(true);
    // Same wallet + same event type after 60s -> allowed again
    expect(evaluateAlertRules(solIn, [rule], tracker, 70_000).matched).toBe(true);
  });

  it("satisfies threshold and cooldown invariants for arbitrary lamport inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n * LAMPORTS_PER_SOL }),
        fc.bigInt({ min: 0n, max: 10_000n * LAMPORTS_PER_SOL }),
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 0, max: 7200 }),
        (lamports, minSolLamports, cooldownSeconds, elapsedSeconds) => {
          const tracker = new CooldownTracker();
          const base = classifyParsedTransaction(makeIncomingSolTx(), watched);
          if (base.kind !== "sol_transfer") return false;
          const synthetic: OnChainEvent = { ...base, lamports };
          const rule = makeRule({ minSolLamports, cooldownSeconds: 0 });

          const first = evaluateAlertRules(synthetic, [rule], tracker, 1_000_000);
          if (first.matched !== lamports >= minSolLamports) return false;

          tracker.record(synthetic.wallet, synthetic.kind, 1_000_000);
          const cooldownRule = makeRule({ minSolLamports: 0n, cooldownSeconds });
          const second = evaluateAlertRules(
            synthetic,
            [cooldownRule],
            tracker,
            1_000_000 + elapsedSeconds * 1000,
          );
          return second.matched === elapsedSeconds >= cooldownSeconds;
        },
      ),
    );
  });

  it("handles CooldownTracker LRU eviction, key replacement, and clear cleanly", () => {
    const tracker = new CooldownTracker();
    expect(tracker.isOnCooldown(watched, "sol_transfer", 0, 1000)).toBe(false);
    expect(tracker.isOnCooldown(watched, "sol_transfer", 60, 1000)).toBe(false);

    // Record and replace existing key
    tracker.record(watched, "sol_transfer", 1000);
    tracker.record(watched, "sol_transfer", 2000);
    expect(tracker.isOnCooldown(watched, "sol_transfer", 60, 2500)).toBe(true);

    // Verify clear() empties tracked timestamps
    tracker.clear();
    expect(tracker.isOnCooldown(watched, "sol_transfer", 60, 2500)).toBe(false);

    // Test LRU capacity bound eviction by populating past MAX_ENTRIES
    const maxEntries = (CooldownTracker as unknown as { MAX_ENTRIES: number }).MAX_ENTRIES;
    const testWallet = parseWalletAddress("11111111111111111111111111111111");
    // Directly prefill the internal map close to max to test the eviction branch efficiently
    const internalMap = (tracker as unknown as { lastTriggeredMs: Map<string, number> })
      .lastTriggeredMs;
    for (let i = 0; i < maxEntries; i += 1) {
      internalMap.set(`key-${i}`, i);
    }
    expect(internalMap.size).toBe(maxEntries);
    // Recording one more key when at maxEntries triggers eviction of oldest
    tracker.record(testWallet, "program_interaction", 99_999);
    expect(internalMap.size).toBe(maxEntries);
    expect(internalMap.has("key-0")).toBe(false);
  });

  it("handles edge branches: no_enabled_rules, below_min_usd, mint_not_in_allowlist, and dex_swap minSolLamports", () => {
    const tracker = new CooldownTracker();
    const solIn = classifyParsedTransaction(makeIncomingSolTx(), watched);
    const splUsdc = classifyParsedTransaction(makeSplUsdcTransferTx(), watched);
    const jupSwap = classifyParsedTransaction(makeJupiterSwapTx(), watched);

    // No enabled rules -> no_enabled_rules
    const disabledRule = makeRule({ enabled: false });
    expect(evaluateAlertRules(solIn, [disabledRule], tracker, 1000)).toEqual({
      matched: false,
      matchedRuleId: null,
      reason: "no_enabled_rules",
    });
    expect(evaluateAlertRules(solIn, [], tracker, 1000)).toEqual({
      matched: false,
      matchedRuleId: null,
      reason: "no_enabled_rules",
    });

    // minUsd threshold filtering
    const minUsdRule = makeRule({ minUsd: 500 });
    const usdRejected = evaluateAlertRules(solIn, [minUsdRule], tracker, 1000, 250);
    expect(usdRejected.matched).toBe(false);
    expect(usdRejected.reason).toBe("below_min_usd");

    // mint_not_in_allowlist
    const bonkOnlyRule = makeRule({ mintAllowlist: [BONK_MINT] });
    const mintReject = evaluateAlertRules(splUsdc, [bonkOnlyRule], tracker, 1000);
    expect(mintReject.matched).toBe(false);
    expect(mintReject.reason).toBe("mint_not_in_allowlist");

    // dex_swap with WSOL leg below minSolLamports
    const highSolSwapRule = makeRule({ minSolLamports: 100n * LAMPORTS_PER_SOL });
    const swapReject = evaluateAlertRules(jupSwap, [highSolSwapRule], tracker, 1000);
    expect(swapReject.matched).toBe(false);
    expect(swapReject.reason).toBe("below_min_sol");
  });
});
