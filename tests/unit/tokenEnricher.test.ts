import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifyParsedTransaction } from "../../src/domain/classifier.js";
import { CooldownTracker, evaluateAlertRules } from "../../src/domain/rules.js";
import {
  formatDisplaySol,
  formatDisplayUnits,
  formatUsdValue,
  USDC_MINT,
  WSOL_MINT,
} from "../../src/domain/tokens.js";
import { parseMintAddress, parseRuleId, parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { JupiterTokenEnricher } from "../../src/solana/tokenEnricher.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  CUSTOM_UNKNOWN_MINT,
  makeIncomingSolTx,
  makeJupiterSwapTx,
  makeProgramOnlyTx,
  makeSplUsdcTransferTx,
  makeToken2022DustTx,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const watched = parseWalletAddress(WATCHED_WALLET_A);

describe("display formatting, USD rule evaluation, and JupiterTokenEnricher", () => {
  it("formats grouped display amounts, sub-threshold dust floor, and USD values cleanly", () => {
    expect(formatDisplayUnits(450_000_00000n, 5)).toBe("450,000");
    expect(formatDisplaySol(12_345_678_900n)).toBe("12.3456");
    expect(formatDisplayUnits(10n, 9, 4)).toBe("<0.0001");
    expect(formatDisplayUnits(-10n, 9, 4)).toBe("-<0.0001");
    expect(formatDisplayUnits(0n, 9, 4)).toBe("0");

    expect(formatUsdValue(0)).toBe("$0.00");
    expect(formatUsdValue(-5)).toBe("$0.00");
    expect(formatUsdValue(0.004)).toBe("<$0.01");
    expect(formatUsdValue(1_234.56)).toBe("$1,234.56");
    expect(formatUsdValue(2_500_000)).toBe("$2.50M");
  });

  it("evaluates minUsd filters in evaluateAlertRules when USD valuation is present", () => {
    const tracker = new CooldownTracker();
    const solIn = classifyParsedTransaction(makeIncomingSolTx(), watched);
    const rule = {
      id: parseRuleId("usd-floor"),
      walletAddress: null,
      minSolLamports: 0n,
      minUsd: 100,
      eventTypes: ["sol_transfer"] as const,
      mintAllowlist: [] as const,
      mintDenylist: [] as const,
      includeFailed: false,
      cooldownSeconds: 0,
      enabled: true,
    };

    const lowUsd = evaluateAlertRules(solIn, [rule], tracker, 1_000, 45);
    expect(lowUsd.matched).toBe(false);
    expect(lowUsd.reason).toBe("below_min_usd");

    expect(evaluateAlertRules(solIn, [rule], tracker, 1_000, 250).matched).toBe(true);
    // Missing USD price does not drop transaction
    expect(evaluateAlertRules(solIn, [rule], tracker, 1_000, null).matched).toBe(true);
  });

  it("enriches SOL transfers, unknown SPL mints, and DEX swaps via SQLite-cached Jupiter APIs", async () => {
    const store = new SqliteStore(":memory:");
    let priceRequests = 0;
    let searchRequests = 0;

    server.use(
      http.get("https://lite-api.jup.ag/price/v3", ({ request }) => {
        priceRequests += 1;
        const ids = new URL(request.url).searchParams.get("ids") ?? "";
        const payload: Record<string, { usdPrice: number }> = {};
        for (const id of ids.split(",")) {
          if (id === WSOL_MINT) payload[id] = { usdPrice: 200 };
          if (id === USDC_MINT) payload[id] = { usdPrice: 1 };
          if (id === CUSTOM_UNKNOWN_MINT) payload[id] = { usdPrice: 4.5 };
        }
        return HttpResponse.json(payload);
      }),
      http.get("https://lite-api.jup.ag/tokens/v2/search", ({ request }) => {
        searchRequests += 1;
        const query = new URL(request.url).searchParams.get("query") ?? "";
        if (query === CUSTOM_UNKNOWN_MINT) {
          return HttpResponse.json([
            {
              id: CUSTOM_UNKNOWN_MINT,
              symbol: "\u001b[31mJUPY\u001b[0m",
              name: "Jupiter Test Token",
              decimals: 9,
            },
          ]);
        }
        return HttpResponse.json([]);
      }),
    );

    let now = 1_000_000;
    const enricher = new JupiterTokenEnricher({
      store,
      logger: createLogger("silent"),
      nowMs: () => now,
    });

    const solEvent = classifyParsedTransaction(makeIncomingSolTx(), watched);
    const enrichedSol1 = await enricher.enrichEvent(solEvent);
    expect(enrichedSol1.estimatedUsd).toBe(500); // 2.5 SOL * $200
    expect(priceRequests).toBe(1);

    // Within 5m cache TTL -> 0 additional HTTP requests
    const enrichedSol2 = await enricher.enrichEvent(solEvent);
    expect(enrichedSol2.estimatedUsd).toBe(500);
    expect(priceRequests).toBe(1);

    const dustEvent = classifyParsedTransaction(makeToken2022DustTx(), watched);
    const enrichedSpl = await enricher.enrichEvent(dustEvent);
    expect(searchRequests).toBe(1);
    expect(enrichedSpl.event.kind === "spl_transfer" ? enrichedSpl.event.symbol : "").toBe("JUPY");
    expect(enrichedSpl.estimatedUsd).toBeCloseTo(0.0045, 5);

    // Second lookup for the same unknown SPL mint hits SQLite metadata + price cache (0 extra search calls)
    const enrichedSplCached = await enricher.enrichEvent(dustEvent);
    expect(searchRequests).toBe(1);
    expect(
      enrichedSplCached.event.kind === "spl_transfer" ? enrichedSplCached.event.symbol : "",
    ).toBe("JUPY");

    const swapEvent = classifyParsedTransaction(makeJupiterSwapTx(), watched);
    const enrichedSwap = await enricher.enrichEvent(swapEvent);
    expect(enrichedSwap.estimatedUsd).toBe(240);

    const progEvent = classifyParsedTransaction(makeProgramOnlyTx(), watched);
    const enrichedProg = await enricher.enrichEvent(progEvent);
    expect(enrichedProg.estimatedUsd).toBeNull();

    // Advance clock past TTL and trigger circuit breaker with upstream HTTP 500s
    now += 600_000;
    let failedCalls = 0;
    server.use(
      http.get("https://lite-api.jup.ag/price/v3", () => {
        failedCalls += 1;
        return new HttpResponse("down", { status: 500 });
      }),
    );

    await enricher.enrichEvent(classifyParsedTransaction(makeSplUsdcTransferTx(), watched));
    await enricher.enrichEvent(classifyParsedTransaction(makeSplUsdcTransferTx(), watched));
    await enricher.enrichEvent(classifyParsedTransaction(makeSplUsdcTransferTx(), watched));
    const countAtOpen = failedCalls;

    // Next call while breaker is open must short-circuit with 0 HTTP requests & stablecoin $1 fallback
    const cachedFallback = await enricher.enrichEvent(
      classifyParsedTransaction(makeSplUsdcTransferTx(), watched),
    );
    expect(failedCalls).toBe(countAtOpen);
    expect(cachedFallback.estimatedUsd).toBe(1250);

    const cachedMeta = store.getTokenMetadata(parseMintAddress(CUSTOM_UNKNOWN_MINT));
    expect(cachedMeta?.symbol).toBe("JUPY");

    // Aborted signal short-circuits cleanly using existing cache
    const aborted = new AbortController();
    aborted.abort();
    const abortedRes = await enricher.enrichEvent(dustEvent, aborted.signal);
    expect(abortedRes.event.kind).toBe("spl_transfer");

    // Alternate Jupiter v2/v3 `{ data: { [mint]: { price: "..." } } }` shape + same-mint swap
    const altStore = new SqliteStore(":memory:");
    const altEnricher = new JupiterTokenEnricher({
      store: altStore,
      logger: createLogger("silent"),
      nowMs: () => now,
    });
    server.use(
      http.get("https://lite-api.jup.ag/price/v3", () =>
        HttpResponse.json({ data: { [WSOL_MINT]: { price: "150" } } }),
      ),
      http.get(
        "https://lite-api.jup.ag/tokens/v2/search",
        () => new HttpResponse("unavailable", { status: 503 }),
      ),
    );
    const solAlt = await altEnricher.enrichEvent(solEvent);
    expect(solAlt.estimatedUsd).toBe(375);

    const badSearchSpl = await altEnricher.enrichEvent(dustEvent);
    expect(badSearchSpl.event.kind === "spl_transfer" ? badSearchSpl.event.symbol : "").not.toBe(
      "JUPY",
    );

    server.use(
      http.get("https://lite-api.jup.ag/tokens/v2/search", () =>
        HttpResponse.json({ invalid: true }),
      ),
    );
    const invalidShapeSpl = await altEnricher.enrichEvent(dustEvent);
    expect(invalidShapeSpl.estimatedUsd).toBeNull();

    server.use(http.get("https://lite-api.jup.ag/tokens/v2/search", () => HttpResponse.json([])));
    const emptySearchSpl = await altEnricher.enrichEvent(dustEvent);
    expect(emptySearchSpl.event.kind).toBe("spl_transfer");

    // Same-mint swap fallback handles identical tokenIn/tokenOut cleanly
    if (swapEvent.kind !== "dex_swap") throw new Error("Expected dex_swap");
    const sameMintSwap = {
      ...swapEvent,
      tokenOut: { ...swapEvent.tokenIn, mint: WSOL_MINT, symbol: "SOL" },
      tokenIn: { ...swapEvent.tokenIn, mint: WSOL_MINT, symbol: "SOL" },
    };
    const sameMintRes = await altEnricher.enrichEvent(sameMintSwap);
    expect(sameMintRes.estimatedUsd).toBe(225);

    altStore.close();
    store.close();
  });
});
