import { z } from "zod";
import {
  resolveTokenMetadata,
  shortAddress,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} from "../domain/tokens.js";
import type { MintAddress, OnChainEvent, TokenLeg } from "../domain/types.js";
import type { AppLogger } from "../logger.js";
import { readBoundedText } from "../notifiers/types.js";
import { sanitizeControlChars } from "../security/sanitize.js";
import { validateOutboundUrl } from "../security/ssrf.js";
import type { CachedTokenMetadata, SqliteStore } from "../store/sqliteStore.js";

const DEFAULT_TOKENS_API_URL = "https://lite-api.jup.ag/tokens/v2/search";
const DEFAULT_PRICE_API_URL = "https://lite-api.jup.ag/price/v3";
const MAX_JUPITER_RESPONSE_BYTES = 65_536;

export type EnrichedEventResult = {
  readonly event: OnChainEvent;
  readonly estimatedUsd: number | null;
};

export interface TokenEnricherPort {
  enrichEvent(event: OnChainEvent, signal?: AbortSignal): Promise<EnrichedEventResult>;
}

export type JupiterTokenEnricherOptions = {
  readonly store: SqliteStore;
  readonly logger: AppLogger;
  readonly tokensApiBaseUrl?: string | undefined;
  readonly priceApiBaseUrl?: string | undefined;
  readonly metadataTtlMs?: number | undefined;
  readonly priceTtlMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly circuitBreakerThreshold?: number | undefined;
  readonly circuitBreakerCooldownMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
};

const JupiterTokenSearchItemSchema = z.object({
  id: z.string(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  decimals: z.number().int().min(0).max(18).optional(),
});

const JupiterTokenSearchArraySchema = z.array(JupiterTokenSearchItemSchema).max(25);

const JupiterPriceEntrySchema = z.object({
  usdPrice: z.union([z.number(), z.string()]).optional(),
  price: z.union([z.number(), z.string()]).optional(),
});

function parseFinitePrice(raw: unknown): number | null {
  const parsed = JupiterPriceEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const candidate = parsed.data.usdPrice ?? parsed.data.price;
  if (candidate === undefined) return null;
  const num = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function stablecoinFallbackPrice(mint: MintAddress): number | null {
  return mint === USDC_MINT || mint === USDT_MINT ? 1 : null;
}

function computeUsdValuation(
  rawAmount: bigint,
  decimals: number,
  usdPrice: number | null,
): number | null {
  if (usdPrice === null || !Number.isFinite(usdPrice) || usdPrice < 0) {
    return null;
  }
  if (rawAmount === 0n) {
    return 0;
  }
  const uiAmount = Number(rawAmount) / 10 ** decimals;
  const value = uiAmount * usdPrice;
  return Number.isFinite(value) ? value : null;
}

export class JupiterTokenEnricher implements TokenEnricherPort {
  private readonly store: SqliteStore;
  private readonly logger: AppLogger;
  private readonly tokensApiBaseUrl: string;
  private readonly priceApiBaseUrl: string;
  private readonly metadataTtlMs: number;
  private readonly priceTtlMs: number;
  private readonly timeoutMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private readonly nowMs: () => number;

  private consecutiveFailures = 0;
  private circuitOpenUntilMs = 0;

  constructor(options: JupiterTokenEnricherOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.tokensApiBaseUrl = validateOutboundUrl(
      options.tokensApiBaseUrl ?? DEFAULT_TOKENS_API_URL,
      { allowedProtocols: ["https:"], allowPrivateHosts: false },
    ).toString();
    this.priceApiBaseUrl = validateOutboundUrl(options.priceApiBaseUrl ?? DEFAULT_PRICE_API_URL, {
      allowedProtocols: ["https:"],
      allowPrivateHosts: false,
    }).toString();
    this.metadataTtlMs = Math.max(1_000, options.metadataTtlMs ?? 86_400_000);
    this.priceTtlMs = Math.max(1_000, options.priceTtlMs ?? 300_000);
    this.timeoutMs = Math.max(200, options.timeoutMs ?? 3_000);
    this.circuitBreakerThreshold = Math.max(1, options.circuitBreakerThreshold ?? 3);
    this.circuitBreakerCooldownMs = Math.max(1_000, options.circuitBreakerCooldownMs ?? 60_000);
    this.nowMs = options.nowMs ?? Date.now;
  }

  async enrichEvent(event: OnChainEvent, signal?: AbortSignal): Promise<EnrichedEventResult> {
    switch (event.kind) {
      case "sol_transfer": {
        const prices = await this.getUsdPrices([WSOL_MINT], signal);
        const solPrice = prices.get(WSOL_MINT) ?? null;
        return {
          event,
          estimatedUsd: computeUsdValuation(event.lamports, 9, solPrice),
        };
      }
      case "spl_transfer": {
        const [meta, prices] = await Promise.all([
          this.resolveMintMetadata(event.mint, event.symbol, event.decimals, signal),
          this.getUsdPrices([event.mint], signal),
        ]);
        const usdPrice = prices.get(event.mint) ?? stablecoinFallbackPrice(event.mint);
        const symbol = meta.symbol || event.symbol;
        const decimals = event.decimals > 0 ? event.decimals : meta.decimals;
        const estimatedUsd = computeUsdValuation(event.rawAmount, decimals, usdPrice);
        return {
          event: symbol !== event.symbol ? { ...event, symbol } : event,
          estimatedUsd,
        };
      }
      case "dex_swap": {
        const mints =
          event.tokenIn.mint === event.tokenOut.mint
            ? [event.tokenIn.mint]
            : [event.tokenIn.mint, event.tokenOut.mint];
        const [inMeta, outMeta, prices] = await Promise.all([
          this.resolveMintMetadata(
            event.tokenIn.mint,
            event.tokenIn.symbol,
            event.tokenIn.decimals,
            signal,
          ),
          this.resolveMintMetadata(
            event.tokenOut.mint,
            event.tokenOut.symbol,
            event.tokenOut.decimals,
            signal,
          ),
          this.getUsdPrices(mints, signal),
        ]);

        const updatedIn: TokenLeg =
          inMeta.symbol !== event.tokenIn.symbol
            ? { ...event.tokenIn, symbol: inMeta.symbol }
            : event.tokenIn;
        const updatedOut: TokenLeg =
          outMeta.symbol !== event.tokenOut.symbol
            ? { ...event.tokenOut, symbol: outMeta.symbol }
            : event.tokenOut;

        const inPrice =
          prices.get(event.tokenIn.mint) ?? stablecoinFallbackPrice(event.tokenIn.mint);
        const outPrice =
          prices.get(event.tokenOut.mint) ?? stablecoinFallbackPrice(event.tokenOut.mint);
        const inUsd = computeUsdValuation(updatedIn.rawAmount, updatedIn.decimals, inPrice);
        const outUsd = computeUsdValuation(updatedOut.rawAmount, updatedOut.decimals, outPrice);

        const updatedEvent =
          updatedIn !== event.tokenIn || updatedOut !== event.tokenOut
            ? { ...event, tokenIn: updatedIn, tokenOut: updatedOut }
            : event;

        return {
          event: updatedEvent,
          estimatedUsd: outUsd ?? inUsd,
        };
      }
      case "program_interaction":
        return { event, estimatedUsd: null };
    }
  }

  private isCircuitOpen(): boolean {
    return this.nowMs() < this.circuitOpenUntilMs;
  }

  private recordUpstreamSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntilMs = 0;
  }

  private recordUpstreamFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitOpenUntilMs = this.nowMs() + this.circuitBreakerCooldownMs;
      this.logger.warn(
        {
          failures: this.consecutiveFailures,
          cooldownMs: this.circuitBreakerCooldownMs,
          err,
        },
        "Jupiter enrichment circuit breaker opened; falling back to local cache",
      );
    } else {
      this.logger.debug({ err }, "Jupiter enrichment lookup failed; falling back to local cache");
    }
  }

  private buildRequestSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  }

  private async resolveMintMetadata(
    mint: MintAddress,
    currentSymbol: string,
    currentDecimals: number,
    signal?: AbortSignal,
  ): Promise<{ readonly symbol: string; readonly name: string; readonly decimals: number }> {
    const known = resolveTokenMetadata(mint);
    if (known.decimals !== null) {
      return { symbol: known.symbol, name: known.symbol, decimals: known.decimals };
    }

    const now = this.nowMs();
    const cached = this.store.getTokenMetadata(mint);
    if (cached && now - cached.updatedAtMs < this.metadataTtlMs) {
      return {
        symbol: cached.symbol,
        name: cached.name,
        decimals: cached.decimals,
      };
    }

    const hasShortFallback = currentSymbol === shortAddress(mint);
    if (this.isCircuitOpen() || signal?.aborted) {
      return {
        symbol: cached?.symbol ?? currentSymbol,
        name: cached?.name ?? currentSymbol,
        decimals: cached?.decimals ?? currentDecimals,
      };
    }

    if (!hasShortFallback && cached) {
      return { symbol: cached.symbol, name: cached.name, decimals: cached.decimals };
    }

    try {
      const url = new URL(this.tokensApiBaseUrl);
      url.searchParams.set("query", mint);
      const response = await fetch(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: this.buildRequestSignal(signal),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Jupiter tokens API returned HTTP ${response.status}`);
      }

      const rawText = await readBoundedText(response, MAX_JUPITER_RESPONSE_BYTES);
      const parsed = JupiterTokenSearchArraySchema.safeParse(JSON.parse(rawText));
      this.recordUpstreamSuccess();
      if (!parsed.success) {
        return {
          symbol: cached?.symbol ?? currentSymbol,
          name: cached?.name ?? currentSymbol,
          decimals: cached?.decimals ?? currentDecimals,
        };
      }

      const exactMatch =
        parsed.data.find((item) => item.id === mint) ??
        (parsed.data.length === 1 ? parsed.data[0] : undefined);
      if (!exactMatch?.symbol) {
        return {
          symbol: cached?.symbol ?? currentSymbol,
          name: cached?.name ?? currentSymbol,
          decimals: cached?.decimals ?? currentDecimals,
        };
      }

      const safeSymbol = sanitizeControlChars(exactMatch.symbol, 24) || currentSymbol;
      const safeName = sanitizeControlChars(exactMatch.name ?? safeSymbol, 64) || safeSymbol;
      const resolvedDecimals = exactMatch.decimals ?? cached?.decimals ?? currentDecimals;

      const updatedCache: CachedTokenMetadata = {
        mint,
        symbol: safeSymbol,
        name: safeName,
        decimals: resolvedDecimals,
        usdPrice: cached?.usdPrice ?? null,
        priceUpdatedAtMs: cached?.priceUpdatedAtMs ?? null,
        updatedAtMs: now,
      };
      this.store.upsertTokenMetadata(updatedCache);
      return { symbol: safeSymbol, name: safeName, decimals: resolvedDecimals };
    } catch (err) {
      this.recordUpstreamFailure(err);
      return {
        symbol: cached?.symbol ?? currentSymbol,
        name: cached?.name ?? currentSymbol,
        decimals: cached?.decimals ?? currentDecimals,
      };
    }
  }

  private async getUsdPrices(
    mints: readonly MintAddress[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<MintAddress, number>> {
    const prices = new Map<MintAddress, number>();
    const missing: MintAddress[] = [];
    const now = this.nowMs();

    for (const mint of mints) {
      const cached = this.store.getTokenMetadata(mint);
      if (
        cached &&
        cached.usdPrice !== null &&
        cached.priceUpdatedAtMs !== null &&
        now - cached.priceUpdatedAtMs < this.priceTtlMs
      ) {
        prices.set(mint, cached.usdPrice);
      } else {
        missing.push(mint);
      }
    }

    if (missing.length === 0 || this.isCircuitOpen() || signal?.aborted) {
      for (const mint of missing) {
        const cached = this.store.getTokenMetadata(mint);
        const fallback = cached?.usdPrice ?? stablecoinFallbackPrice(mint);
        if (fallback !== null) {
          prices.set(mint, fallback);
        }
      }
      return prices;
    }

    try {
      const url = new URL(this.priceApiBaseUrl);
      url.searchParams.set("ids", missing.join(","));
      const response = await fetch(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: this.buildRequestSignal(signal),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Jupiter price API returned HTTP ${response.status}`);
      }

      const rawText = await readBoundedText(response, MAX_JUPITER_RESPONSE_BYTES);
      const json = JSON.parse(rawText) as { data?: Record<string, unknown> } & Record<
        string,
        unknown
      >;
      const recordMap: Record<string, unknown> =
        typeof json.data === "object" && json.data !== null && !Array.isArray(json.data)
          ? json.data
          : json;

      this.recordUpstreamSuccess();

      for (const mint of missing) {
        const parsedPrice = parseFinitePrice(recordMap[mint]);
        const existing = this.store.getTokenMetadata(mint);
        if (parsedPrice !== null) {
          prices.set(mint, parsedPrice);
          const known = resolveTokenMetadata(mint);
          this.store.upsertTokenMetadata({
            mint,
            symbol: existing?.symbol ?? known.symbol,
            name: existing?.name ?? known.symbol,
            decimals: existing?.decimals ?? known.decimals ?? 9,
            usdPrice: parsedPrice,
            priceUpdatedAtMs: now,
            updatedAtMs: existing?.updatedAtMs ?? now,
          });
        } else {
          const fallback = existing?.usdPrice ?? stablecoinFallbackPrice(mint);
          if (fallback !== null) {
            prices.set(mint, fallback);
          }
        }
      }
    } catch (err) {
      this.recordUpstreamFailure(err);
      for (const mint of missing) {
        const cached = this.store.getTokenMetadata(mint);
        const fallback = cached?.usdPrice ?? stablecoinFallbackPrice(mint);
        if (fallback !== null) {
          prices.set(mint, fallback);
        }
      }
    }

    return prices;
  }
}
