import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors.js";
import {
  formatLamportsAsSol,
  formatUnits,
  LAMPORTS_PER_SOL,
  parseSolToLamports,
  resolveTokenMetadata,
  shortAddress,
  USDC_MINT,
  WSOL_MINT,
} from "../../src/domain/tokens.js";
import { parseMintAddress } from "../../src/domain/types.js";

describe("tokens and BigInt unit math", () => {
  it("formats lamports and token units without floating-point precision loss", () => {
    expect(formatLamportsAsSol(1_000_000_000n)).toBe("1");
    expect(formatLamportsAsSol(1_250_000_000n)).toBe("1.25");
    expect(formatLamportsAsSol(1n, 9)).toBe("0.000000001");
    expect(formatLamportsAsSol(-500_000_000n)).toBe("-0.5");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    // Exact u64 boundary precision check (exceeds Number.MAX_SAFE_INTEGER)
    expect(formatUnits(18_446_744_073_709_551_615n, 9, 9)).toBe("18446744073.709551615");
  });

  it("caps fractional precision and trims trailing zeros", () => {
    expect(formatUnits(1_234_567_890n, 9, 4)).toBe("1.2345");
    expect(formatUnits(1_200_000_000n, 9, 4)).toBe("1.2");
    expect(formatUnits(1_000_000_000n, 9, 0)).toBe("1");
    expect(formatUnits(42n, 0, 2)).toBe("42");
  });

  it("rejects negative decimals or maxFractionDigits", () => {
    expect(() => formatUnits(100n, -1)).toThrow(ValidationError);
    expect(() => formatUnits(100n, 6, -1)).toThrow(ValidationError);
  });

  it("parses SOL decimal strings into exact lamports", () => {
    expect(parseSolToLamports("0")).toBe(0n);
    expect(parseSolToLamports("1")).toBe(LAMPORTS_PER_SOL);
    expect(parseSolToLamports("0.000000001")).toBe(1n);
    expect(parseSolToLamports("2.5")).toBe(2_500_000_000n);
    expect(() => parseSolToLamports("-1")).toThrow(ValidationError);
    expect(() => parseSolToLamports("0.1234567891")).toThrow(ValidationError);
    expect(() => parseSolToLamports("abc")).toThrow(ValidationError);
  });

  it("roundtrips arbitrary non-negative lamport values through SOL formatting and parsing", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 500_000_000_000_000_000n }), (lamports) => {
        const formatted = formatLamportsAsSol(lamports, 9);
        const parsed = parseSolToLamports(formatted);
        return parsed === lamports;
      }),
    );
  });

  it("resolves known mainnet mints and falls back cleanly for unknown mints", () => {
    const usdc = resolveTokenMetadata(USDC_MINT);
    expect(usdc.symbol).toBe("USDC");
    expect(usdc.decimals).toBe(6);

    const wsol = resolveTokenMetadata(WSOL_MINT);
    expect(wsol.symbol).toBe("SOL");
    expect(wsol.decimals).toBe(9);

    const unknownMint = parseMintAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    expect(resolveTokenMetadata(unknownMint).symbol).toBe("BONK");

    const customMint = parseMintAddress("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");
    const custom = resolveTokenMetadata(customMint);
    expect(custom.symbol).toBe("4k3D...rkX6R");
    expect(custom.decimals).toBeNull();
  });

  it("shortens long addresses and keeps short strings intact", () => {
    expect(shortAddress("So11111111111111111111111111111111111111112")).toBe("So11...11112");
    expect(shortAddress("short")).toBe("short");
  });
});
