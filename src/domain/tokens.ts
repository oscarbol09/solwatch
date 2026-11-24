import { ValidationError } from "./errors.js";
import { type MintAddress, parseMintAddress } from "./types.js";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const WSOL_MINT = parseMintAddress("So11111111111111111111111111111111111111112");
export const USDC_MINT = parseMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT_MINT = parseMintAddress("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
export const JUP_MINT = parseMintAddress("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
export const BONK_MINT = parseMintAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
export const WIF_MINT = parseMintAddress("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
export const JITOSOL_MINT = parseMintAddress("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
export const MSOL_MINT = parseMintAddress("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
export const PYTH_MINT = parseMintAddress("HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3");

type KnownTokenEntry = {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
};

const KNOWN_TOKEN_MAP: ReadonlyMap<MintAddress, KnownTokenEntry> = new Map([
  [WSOL_MINT, { symbol: "SOL", name: "Wrapped SOL", decimals: 9 }],
  [USDC_MINT, { symbol: "USDC", name: "USD Coin", decimals: 6 }],
  [USDT_MINT, { symbol: "USDT", name: "Tether USD", decimals: 6 }],
  [JUP_MINT, { symbol: "JUP", name: "Jupiter", decimals: 6 }],
  [BONK_MINT, { symbol: "BONK", name: "Bonk", decimals: 5 }],
  [WIF_MINT, { symbol: "WIF", name: "dogwifhat", decimals: 6 }],
  [JITOSOL_MINT, { symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9 }],
  [MSOL_MINT, { symbol: "mSOL", name: "Marinade Staked SOL", decimals: 9 }],
  [PYTH_MINT, { symbol: "PYTH", name: "Pyth Network", decimals: 6 }],
]);

export type ResolvedTokenMetadata = {
  readonly symbol: string;
  readonly decimals: number | null;
};

export function shortAddress(addr: string): string {
  if (addr.length <= 12) {
    return addr;
  }
  return `${addr.slice(0, 4)}...${addr.slice(-5)}`;
}

export function resolveTokenMetadata(mint: MintAddress): ResolvedTokenMetadata {
  const known = KNOWN_TOKEN_MAP.get(mint);
  if (known !== undefined) {
    return { symbol: known.symbol, decimals: known.decimals };
  }
  return { symbol: shortAddress(mint), decimals: null };
}

export function formatUnits(rawAmount: bigint, decimals: number, maxFractionDigits = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new ValidationError("Token decimals must be a non-negative integer", { decimals });
  }
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0) {
    throw new ValidationError("maxFractionDigits must be a non-negative integer", {
      maxFractionDigits,
    });
  }

  const sign = rawAmount < 0n ? "-" : "";
  const absAmount = rawAmount < 0n ? -rawAmount : rawAmount;

  if (decimals === 0) {
    return `${sign}${absAmount.toString()}`;
  }

  const base = 10n ** BigInt(decimals);
  const whole = absAmount / base;
  const fraction = absAmount % base;

  if (fraction === 0n || maxFractionDigits === 0) {
    return `${sign}${whole.toString()}`;
  }

  const paddedFraction = fraction.toString().padStart(decimals, "0");
  const cappedFraction = paddedFraction.slice(0, maxFractionDigits).replace(/0+$/, "");

  if (cappedFraction.length === 0) {
    return `${sign}${whole.toString()}`;
  }
  return `${sign}${whole.toString()}.${cappedFraction}`;
}

export function formatLamportsAsSol(lamports: bigint, maxFractionDigits = 4): string {
  return formatUnits(lamports, 9, maxFractionDigits);
}

export function formatGroupedInteger(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatDisplayUnits(
  rawAmount: bigint,
  decimals: number,
  maxFractionDigits = 4,
): string {
  const formatted = formatUnits(rawAmount, decimals, maxFractionDigits);
  const sign = formatted.startsWith("-") ? "-" : "";
  const unsigned = sign ? formatted.slice(1) : formatted;

  if (rawAmount !== 0n && unsigned === "0" && maxFractionDigits > 0) {
    return `${sign}<0.${"0".repeat(maxFractionDigits - 1)}1`;
  }

  const [wholePart = "0", fracPart] = unsigned.split(".");
  const groupedWhole = formatGroupedInteger(wholePart);
  return fracPart !== undefined && fracPart.length > 0
    ? `${sign}${groupedWhole}.${fracPart}`
    : `${sign}${groupedWhole}`;
}

export function formatDisplaySol(lamports: bigint, maxFractionDigits = 4): string {
  return formatDisplayUnits(lamports, 9, maxFractionDigits);
}

export function formatUsdValue(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toFixed(2)}M`;
  }
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseSolToLamports(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ValidationError(`Invalid SOL amount: "${input}"`, { field: "minSol" });
  }

  const [wholeStr, fracStr = ""] = trimmed.split(".");
  if (fracStr.length > 9) {
    throw new ValidationError(`SOL precision exceeds 9 decimals: "${input}"`, { field: "minSol" });
  }

  const whole = BigInt(wholeStr ?? "0") * LAMPORTS_PER_SOL;
  const frac = fracStr.length === 0 ? 0n : BigInt(fracStr.padEnd(9, "0"));
  return whole + frac;
}
