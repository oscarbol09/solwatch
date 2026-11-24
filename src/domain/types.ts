import { type Address, isAddress, isSignature, type Signature } from "@solana/kit";
import { z } from "zod";
import { sanitizeControlChars } from "../security/sanitize.js";
import { ValidationError } from "./errors.js";

declare const solwatchBrand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [solwatchBrand]: B };

export type WalletAddress = Brand<Address, "WalletAddress">;
export type MintAddress = Brand<Address, "MintAddress">;
export type TxSignature = Brand<Signature, "TxSignature">;
export type RuleId = Brand<string, "RuleId">;

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet";
export type CommitmentLevel = "processed" | "confirmed" | "finalized";
export type EventType = "sol_transfer" | "spl_transfer" | "dex_swap" | "program_interaction";

export type TokenLeg = {
  readonly mint: MintAddress;
  readonly symbol: string;
  readonly rawAmount: bigint;
  readonly decimals: number;
};

export type OnChainEvent =
  | {
      readonly kind: "sol_transfer";
      readonly signature: TxSignature;
      readonly slot: bigint;
      readonly timestampSec: number | null;
      readonly wallet: WalletAddress;
      readonly direction: "in" | "out";
      readonly counterparty: string | null;
      readonly lamports: bigint;
      readonly feeLamports: bigint;
      readonly success: boolean;
    }
  | {
      readonly kind: "spl_transfer";
      readonly signature: TxSignature;
      readonly slot: bigint;
      readonly timestampSec: number | null;
      readonly wallet: WalletAddress;
      readonly direction: "in" | "out";
      readonly mint: MintAddress;
      readonly symbol: string;
      readonly rawAmount: bigint;
      readonly decimals: number;
      readonly counterparty: string | null;
      readonly feeLamports: bigint;
      readonly success: boolean;
    }
  | {
      readonly kind: "dex_swap";
      readonly signature: TxSignature;
      readonly slot: bigint;
      readonly timestampSec: number | null;
      readonly wallet: WalletAddress;
      readonly dex: string;
      readonly programId: string;
      readonly tokenIn: TokenLeg;
      readonly tokenOut: TokenLeg;
      readonly feeLamports: bigint;
      readonly success: boolean;
    }
  | {
      readonly kind: "program_interaction";
      readonly signature: TxSignature;
      readonly slot: bigint;
      readonly timestampSec: number | null;
      readonly wallet: WalletAddress;
      readonly programIds: readonly string[];
      readonly summary: string;
      readonly feeLamports: bigint;
      readonly success: boolean;
    };

export type WatchedWallet = {
  readonly address: WalletAddress;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly lastSignature: TxSignature | null;
  readonly lastSlot: bigint | null;
  readonly lastRpcSignature: TxSignature | null;
  readonly lastRpcSlot: bigint | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AlertRule = {
  readonly id: RuleId;
  readonly walletAddress: WalletAddress | null;
  readonly minSolLamports: bigint;
  readonly eventTypes: readonly EventType[];
  readonly mintAllowlist: readonly MintAddress[];
  readonly mintDenylist: readonly MintAddress[];
  readonly includeFailed: boolean;
  readonly cooldownSeconds: number;
  readonly enabled: boolean;
};

export function tryParseWalletAddress(raw: string): WalletAddress | null {
  const trimmed = raw.trim();
  return isAddress(trimmed) ? (trimmed as WalletAddress) : null;
}

export function parseWalletAddress(raw: string): WalletAddress {
  const parsed = tryParseWalletAddress(raw);
  if (parsed === null) {
    throw new ValidationError(`Invalid Solana wallet address: "${sanitizeControlChars(raw, 64)}"`, {
      field: "wallet",
    });
  }
  return parsed;
}

export function tryParseMintAddress(raw: string): MintAddress | null {
  const trimmed = raw.trim();
  return isAddress(trimmed) ? (trimmed as MintAddress) : null;
}

export function parseMintAddress(raw: string): MintAddress {
  const parsed = tryParseMintAddress(raw);
  if (parsed === null) {
    throw new ValidationError(`Invalid Solana mint address: "${sanitizeControlChars(raw, 64)}"`, {
      field: "mint",
    });
  }
  return parsed;
}

export function parseTxSignature(raw: string): TxSignature {
  const trimmed = raw.trim();
  if (!isSignature(trimmed)) {
    throw new ValidationError(
      `Invalid Solana transaction signature: "${sanitizeControlChars(raw, 64)}"`,
      {
        field: "signature",
      },
    );
  }
  return trimmed as TxSignature;
}

export function parseRuleId(raw: string): RuleId {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Rule ID cannot be empty", { field: "ruleId" });
  }
  return trimmed as RuleId;
}

export function assertNever(value: never, message = "Unhandled union member"): never {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  throw new Error(`${message}: ${serialized}`);
}

const BigIntStringSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => BigInt(v));

const StoredTokenLegSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  rawAmount: BigIntStringSchema,
  decimals: z.number().int().min(0).max(18),
});

const BaseStoredEventSchema = {
  signature: z.string(),
  slot: BigIntStringSchema,
  timestampSec: z.number().nullable(),
  wallet: z.string(),
  feeLamports: BigIntStringSchema,
  success: z.boolean(),
};

const StoredEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sol_transfer"),
    ...BaseStoredEventSchema,
    direction: z.enum(["in", "out"]),
    counterparty: z.string().nullable(),
    lamports: BigIntStringSchema,
  }),
  z.object({
    kind: z.literal("spl_transfer"),
    ...BaseStoredEventSchema,
    direction: z.enum(["in", "out"]),
    mint: z.string(),
    symbol: z.string(),
    rawAmount: BigIntStringSchema,
    decimals: z.number().int().min(0).max(18),
    counterparty: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("dex_swap"),
    ...BaseStoredEventSchema,
    dex: z.string(),
    programId: z.string(),
    tokenIn: StoredTokenLegSchema,
    tokenOut: StoredTokenLegSchema,
  }),
  z.object({
    kind: z.literal("program_interaction"),
    ...BaseStoredEventSchema,
    programIds: z.array(z.string()),
    summary: z.string(),
  }),
]);

export function serializeOnChainEvent(event: OnChainEvent): string {
  return JSON.stringify(event, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function deserializeOnChainEvent(rawJson: string): OnChainEvent {
  const parsed = StoredEventSchema.parse(JSON.parse(rawJson));
  const signature = parseTxSignature(parsed.signature);
  const wallet = parseWalletAddress(parsed.wallet);

  switch (parsed.kind) {
    case "sol_transfer":
      return {
        kind: "sol_transfer",
        signature,
        slot: parsed.slot,
        timestampSec: parsed.timestampSec,
        wallet,
        direction: parsed.direction,
        counterparty: parsed.counterparty,
        lamports: parsed.lamports,
        feeLamports: parsed.feeLamports,
        success: parsed.success,
      };
    case "spl_transfer":
      return {
        kind: "spl_transfer",
        signature,
        slot: parsed.slot,
        timestampSec: parsed.timestampSec,
        wallet,
        direction: parsed.direction,
        mint: parseMintAddress(parsed.mint),
        symbol: parsed.symbol,
        rawAmount: parsed.rawAmount,
        decimals: parsed.decimals,
        counterparty: parsed.counterparty,
        feeLamports: parsed.feeLamports,
        success: parsed.success,
      };
    case "dex_swap":
      return {
        kind: "dex_swap",
        signature,
        slot: parsed.slot,
        timestampSec: parsed.timestampSec,
        wallet,
        dex: parsed.dex,
        programId: parsed.programId,
        tokenIn: {
          mint: parseMintAddress(parsed.tokenIn.mint),
          symbol: parsed.tokenIn.symbol,
          rawAmount: parsed.tokenIn.rawAmount,
          decimals: parsed.tokenIn.decimals,
        },
        tokenOut: {
          mint: parseMintAddress(parsed.tokenOut.mint),
          symbol: parsed.tokenOut.symbol,
          rawAmount: parsed.tokenOut.rawAmount,
          decimals: parsed.tokenOut.decimals,
        },
        feeLamports: parsed.feeLamports,
        success: parsed.success,
      };
    case "program_interaction":
      return {
        kind: "program_interaction",
        signature,
        slot: parsed.slot,
        timestampSec: parsed.timestampSec,
        wallet,
        programIds: parsed.programIds,
        summary: parsed.summary,
        feeLamports: parsed.feeLamports,
        success: parsed.success,
      };
    default:
      return assertNever(parsed);
  }
}
