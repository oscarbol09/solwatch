import { z } from "zod";
import { JITO_TIP_ACCOUNTS, normalizeTokenScale18 } from "../domain/classifier.js";
import { ValidationError } from "../domain/errors.js";
import { resolveTokenMetadata, WSOL_MINT } from "../domain/tokens.js";
import {
  type MintAddress,
  type OnChainEvent,
  parseTxSignature,
  type TokenLeg,
  type TxSignature,
  tryParseMintAddress,
  tryParseWalletAddress,
  type WalletAddress,
} from "../domain/types.js";
import { sanitizeControlChars } from "../security/sanitize.js";

const UNSIGNED_INT_STRING = /^\d{1,39}$/;
const MAX_HELIUS_BATCH_SIZE = 200;

const HELIUS_SOURCE_TO_PROGRAM_ID = new Map<string, string>([
  ["JUPITER", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  ["RAYDIUM", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
  ["RAYDIUM_CLMM", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"],
  ["ORCA", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
  ["METEORA", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"],
  ["PUMP_FUN", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
  ["PUMP_AMM", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
  ["PHOENIX", "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"],
  ["LIFINITY", "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c"],
  ["TENSOR", "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN"],
  ["MAGIC_EDEN", "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K"],
]);

const HeliusNativeTransferSchema = z.object({
  fromUserAccount: z.string().nullish(),
  toUserAccount: z.string().nullish(),
  amount: z.number().nonnegative(),
});

const HeliusTokenTransferSchema = z.object({
  fromUserAccount: z.string().nullish(),
  toUserAccount: z.string().nullish(),
  mint: z.string(),
  tokenAmount: z.number().nonnegative(),
});

const HeliusRawTokenAmountSchema = z.object({
  tokenAmount: z.string().regex(UNSIGNED_INT_STRING, "Expected non-negative integer string"),
  decimals: z.number().int().min(0).max(18),
});

const HeliusSwapTokenSchema = z.object({
  userAccount: z.string().nullish(),
  mint: z.string(),
  rawTokenAmount: HeliusRawTokenAmountSchema,
});

const HeliusSwapNativeSchema = z.object({
  account: z.string().nullish(),
  amount: z
    .union([
      z.string().regex(UNSIGNED_INT_STRING, "Expected non-negative integer string"),
      z.literal(""),
    ])
    .transform((v) => (v === "" ? "0" : v)),
});

const HeliusTransactionSchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  timestamp: z.number().int().min(0).max(8_640_000_000).nullish(),
  fee: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform((v) => v ?? 0),
  feePayer: z.string().nullish(),
  type: z
    .string()
    .max(100)
    .nullish()
    .transform((v) => sanitizeControlChars(v ?? "UNKNOWN", 100) || "UNKNOWN"),
  source: z
    .string()
    .max(100)
    .nullish()
    .transform((v) => sanitizeControlChars(v ?? "UNKNOWN", 100) || "UNKNOWN"),
  description: z
    .string()
    .max(500)
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const clean = sanitizeControlChars(v, 240);
      return clean.length > 0 ? clean : null;
    }),
  transactionError: z.unknown().nullish(),
  nativeTransfers: z.array(HeliusNativeTransferSchema).max(MAX_HELIUS_BATCH_SIZE).nullish(),
  tokenTransfers: z.array(HeliusTokenTransferSchema).max(MAX_HELIUS_BATCH_SIZE).nullish(),
  events: z
    .object({
      swap: z
        .object({
          nativeInput: HeliusSwapNativeSchema.nullish(),
          nativeOutput: HeliusSwapNativeSchema.nullish(),
          tokenInputs: z.array(HeliusSwapTokenSchema).max(MAX_HELIUS_BATCH_SIZE).nullish(),
          tokenOutputs: z.array(HeliusSwapTokenSchema).max(MAX_HELIUS_BATCH_SIZE).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const HeliusPayloadSchema = z.array(HeliusTransactionSchema).max(MAX_HELIUS_BATCH_SIZE);
const HeliusOuterArraySchema = z.array(z.unknown()).max(MAX_HELIUS_BATCH_SIZE);

type HeliusTx = z.infer<typeof HeliusTransactionSchema>;
type HeliusSwapEvent = NonNullable<NonNullable<HeliusTx["events"]>["swap"]>;

export type HeliusBatchParseResult = {
  readonly events: readonly OnChainEvent[];
  readonly skippedInvalid: number;
};

function decimalNumberToBaseUnits(
  value: number,
  fixedDecimals: number | null,
): { readonly rawAmount: bigint; readonly decimals: number } {
  if (!Number.isFinite(value) || value <= 0) {
    return { rawAmount: 0n, decimals: fixedDecimals ?? 0 };
  }
  const plain = value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: fixedDecimals ?? 9,
  });
  const [wholePart = "0", fracPart = ""] = plain.split(".");
  const decimals = fixedDecimals ?? Math.min(9, fracPart.length);
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  const rawAmount = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
  return { rawAmount, decimals };
}

function collectCandidateWallets(
  tx: HeliusTx,
  watchedSet: ReadonlySet<WalletAddress>,
): readonly WalletAddress[] {
  const candidates = new Set<string>();
  if (tx.feePayer) candidates.add(tx.feePayer);
  for (const nt of tx.nativeTransfers ?? []) {
    if (nt.fromUserAccount) candidates.add(nt.fromUserAccount);
    if (nt.toUserAccount) candidates.add(nt.toUserAccount);
  }
  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.fromUserAccount) candidates.add(tt.fromUserAccount);
    if (tt.toUserAccount) candidates.add(tt.toUserAccount);
  }
  const swap = tx.events?.swap;
  if (swap) {
    if (swap.nativeInput?.account) candidates.add(swap.nativeInput.account);
    if (swap.nativeOutput?.account) candidates.add(swap.nativeOutput.account);
    for (const ti of swap.tokenInputs ?? []) {
      if (ti.userAccount) candidates.add(ti.userAccount);
    }
    for (const to of swap.tokenOutputs ?? []) {
      if (to.userAccount) candidates.add(to.userAccount);
    }
  }

  const matched: WalletAddress[] = [];
  for (const candidate of candidates) {
    const parsed = tryParseWalletAddress(candidate);
    if (parsed !== null && watchedSet.has(parsed)) {
      matched.push(parsed);
    }
  }
  return matched;
}

function isWalletSwapOwner(tx: HeliusTx, swap: HeliusSwapEvent, wallet: WalletAddress): boolean {
  const explicitOwners = new Set<string>();
  if (swap.nativeInput?.account) explicitOwners.add(swap.nativeInput.account);
  if (swap.nativeOutput?.account) explicitOwners.add(swap.nativeOutput.account);
  for (const leg of swap.tokenInputs ?? []) {
    if (leg.userAccount) explicitOwners.add(leg.userAccount);
  }
  for (const leg of swap.tokenOutputs ?? []) {
    if (leg.userAccount) explicitOwners.add(leg.userAccount);
  }
  if (explicitOwners.size > 0) {
    return explicitOwners.has(wallet);
  }
  return tx.feePayer === wallet;
}

function buildSwapLegFromHelius(
  nativeLeg:
    | { readonly account?: string | null | undefined; readonly amount: string }
    | null
    | undefined,
  tokenLegs: readonly z.infer<typeof HeliusSwapTokenSchema>[] | null | undefined,
  wallet: WalletAddress,
): TokenLeg | null {
  if (
    nativeLeg &&
    BigInt(nativeLeg.amount) > 0n &&
    (!nativeLeg.account || nativeLeg.account === wallet)
  ) {
    return {
      mint: WSOL_MINT,
      symbol: "SOL",
      rawAmount: BigInt(nativeLeg.amount),
      decimals: 9,
    };
  }

  const allLegs = tokenLegs ?? [];
  if (allLegs.length === 0) return null;

  const hasExplicitOwner = allLegs.some((leg) => Boolean(leg.userAccount));
  const scopedLegs = hasExplicitOwner
    ? allLegs.filter((leg) => leg.userAccount === wallet)
    : allLegs;
  if (scopedLegs.length === 0) return null;

  const summedByMint = new Map<MintAddress, { readonly decimals: number; rawAmount: bigint }>();
  for (const item of scopedLegs) {
    const mint = tryParseMintAddress(item.mint);
    if (mint === null) continue;
    const rawAmount = BigInt(item.rawTokenAmount.tokenAmount);
    if (rawAmount <= 0n) continue;
    const existing = summedByMint.get(mint);
    if (existing) {
      existing.rawAmount += rawAmount;
    } else {
      summedByMint.set(mint, { decimals: item.rawTokenAmount.decimals, rawAmount });
    }
  }

  let best: TokenLeg | null = null;
  let bestScaled = -1n;
  for (const [mint, agg] of summedByMint.entries()) {
    const scaled = normalizeTokenScale18(agg.rawAmount, agg.decimals);
    if (!best || scaled > bestScaled) {
      const meta = resolveTokenMetadata(mint);
      best = {
        mint,
        symbol: meta.symbol,
        rawAmount: agg.rawAmount,
        decimals: agg.decimals,
      };
      bestScaled = scaled;
    }
  }
  return best;
}

function resolveHeliusProgramId(source: string): string {
  return HELIUS_SOURCE_TO_PROGRAM_ID.get(source.toUpperCase()) ?? source;
}

function findPrimarySplTransfer(
  tx: HeliusTx,
  wallet: WalletAddress,
): {
  readonly direction: "in" | "out";
  readonly mint: MintAddress;
  readonly symbol: string;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly counterparty: string | null;
} | null {
  type AggMint = {
    readonly mint: MintAddress;
    readonly symbol: string;
    readonly decimals: number;
    netDelta: bigint;
    bestInAmount: bigint;
    bestInFrom: string | null;
    bestOutAmount: bigint;
    bestOutTo: string | null;
  };
  const byMint = new Map<MintAddress, AggMint>();

  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.tokenAmount <= 0) continue;
    const isIncoming = tt.toUserAccount === wallet;
    const isOutgoing = tt.fromUserAccount === wallet;
    if (!isIncoming && !isOutgoing) continue;

    const mint = tryParseMintAddress(tt.mint);
    if (mint === null) continue;

    const resolved = resolveTokenMetadata(mint);
    const converted = decimalNumberToBaseUnits(tt.tokenAmount, resolved.decimals);
    if (converted.rawAmount === 0n) continue;

    const bucket = byMint.get(mint) ?? {
      mint,
      symbol: resolved.symbol,
      decimals: converted.decimals,
      netDelta: 0n,
      bestInAmount: 0n,
      bestInFrom: null,
      bestOutAmount: 0n,
      bestOutTo: null,
    };

    if (isIncoming && !isOutgoing) {
      bucket.netDelta += converted.rawAmount;
      if (converted.rawAmount > bucket.bestInAmount) {
        bucket.bestInAmount = converted.rawAmount;
        bucket.bestInFrom = tt.fromUserAccount ?? null;
      }
    } else if (isOutgoing && !isIncoming) {
      bucket.netDelta -= converted.rawAmount;
      if (converted.rawAmount > bucket.bestOutAmount) {
        bucket.bestOutAmount = converted.rawAmount;
        bucket.bestOutTo = tt.toUserAccount ?? null;
      }
    }
    byMint.set(mint, bucket);
  }

  let best: {
    readonly direction: "in" | "out";
    readonly mint: MintAddress;
    readonly symbol: string;
    readonly rawAmount: bigint;
    readonly decimals: number;
    readonly counterparty: string | null;
  } | null = null;
  let bestScaled = -1n;

  for (const bucket of byMint.values()) {
    if (bucket.netDelta === 0n) continue;
    const isIncoming = bucket.netDelta > 0n;
    const rawAmount = isIncoming ? bucket.netDelta : -bucket.netDelta;
    const scaled = normalizeTokenScale18(rawAmount, bucket.decimals);
    if (!best || scaled > bestScaled) {
      best = {
        direction: isIncoming ? "in" : "out",
        mint: bucket.mint,
        symbol: bucket.symbol,
        rawAmount,
        decimals: bucket.decimals,
        counterparty: isIncoming ? bucket.bestInFrom : bucket.bestOutTo,
      };
      bestScaled = scaled;
    }
  }

  return best;
}

function findPrimaryNativeTransfer(
  tx: HeliusTx,
  wallet: WalletAddress,
): {
  readonly direction: "in" | "out";
  readonly counterparty: string | null;
  readonly lamports: bigint;
} | null {
  const byCounterparty = new Map<string, bigint>();

  for (const nt of tx.nativeTransfers ?? []) {
    if (nt.amount <= 0) continue;
    const isIncoming = nt.toUserAccount === wallet;
    const isOutgoing = nt.fromUserAccount === wallet;
    if (!isIncoming && !isOutgoing) continue;
    if (isIncoming && isOutgoing) continue;

    const counterparty = (isIncoming ? nt.fromUserAccount : nt.toUserAccount) ?? "";
    if (!isIncoming && JITO_TIP_ACCOUNTS.has(counterparty)) continue;

    const lamports = BigInt(Math.trunc(nt.amount));
    if (lamports <= 0n) continue;
    const signed = isIncoming ? lamports : -lamports;
    byCounterparty.set(counterparty, (byCounterparty.get(counterparty) ?? 0n) + signed);
  }

  let best: {
    readonly direction: "in" | "out";
    readonly counterparty: string | null;
    readonly lamports: bigint;
  } | null = null;

  for (const [counterparty, signedNet] of byCounterparty.entries()) {
    if (signedNet === 0n) continue;
    const lamports = signedNet > 0n ? signedNet : -signedNet;
    if (!best || lamports > best.lamports) {
      best = {
        direction: signedNet > 0n ? "in" : "out",
        counterparty: counterparty.length > 0 ? counterparty : null,
        lamports,
      };
    }
  }

  return best;
}

function mapHeliusTxForWallet(
  tx: HeliusTx,
  signature: TxSignature,
  wallet: WalletAddress,
): OnChainEvent {
  const slot = BigInt(tx.slot);
  const timestampSec = tx.timestamp ?? null;
  const feeLamports = BigInt(tx.fee);
  const success = tx.transactionError === null || tx.transactionError === undefined;
  const programId = resolveHeliusProgramId(tx.source);

  if (!success) {
    return {
      kind: "program_interaction",
      signature,
      slot,
      timestampSec,
      wallet,
      programIds: [programId],
      summary: tx.description ?? `Failed ${tx.type} via ${tx.source}`,
      feeLamports,
      success: false,
    };
  }

  const swap = tx.events?.swap;
  if (tx.type === "SWAP" && swap && isWalletSwapOwner(tx, swap, wallet)) {
    const tokenIn = buildSwapLegFromHelius(swap.nativeInput, swap.tokenInputs, wallet);
    const tokenOut = buildSwapLegFromHelius(swap.nativeOutput, swap.tokenOutputs, wallet);
    if (tokenIn && tokenOut && tokenIn.mint !== tokenOut.mint) {
      return {
        kind: "dex_swap",
        signature,
        slot,
        timestampSec,
        wallet,
        dex: tx.source,
        programId,
        tokenIn,
        tokenOut,
        feeLamports,
        success: true,
      };
    }
  }

  const primarySpl = findPrimarySplTransfer(tx, wallet);
  if (primarySpl) {
    return {
      kind: "spl_transfer",
      signature,
      slot,
      timestampSec,
      wallet,
      direction: primarySpl.direction,
      mint: primarySpl.mint,
      symbol: primarySpl.symbol,
      rawAmount: primarySpl.rawAmount,
      decimals: primarySpl.decimals,
      counterparty: primarySpl.counterparty,
      feeLamports,
      success: true,
    };
  }

  const primarySol = findPrimaryNativeTransfer(tx, wallet);
  if (primarySol) {
    return {
      kind: "sol_transfer",
      signature,
      slot,
      timestampSec,
      wallet,
      direction: primarySol.direction,
      counterparty: primarySol.counterparty,
      lamports: primarySol.lamports,
      feeLamports,
      success: true,
    };
  }

  return {
    kind: "program_interaction",
    signature,
    slot,
    timestampSec,
    wallet,
    programIds: [programId],
    summary: tx.description ?? `${tx.type} on ${tx.source}`,
    feeLamports,
    success: true,
  };
}

export function parseHeliusWebhookBatch(
  payload: unknown,
  watchedWallets: ReadonlySet<WalletAddress>,
): HeliusBatchParseResult {
  const outer = HeliusOuterArraySchema.safeParse(payload);
  if (!outer.success) {
    throw new ValidationError("Malformed Helius webhook payload", {
      issues: outer.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const events: OnChainEvent[] = [];
  let skippedInvalid = 0;

  for (const rawItem of outer.data) {
    const parsedItem = HeliusTransactionSchema.safeParse(rawItem);
    if (!parsedItem.success) {
      skippedInvalid += 1;
      continue;
    }
    try {
      const signature = parseTxSignature(parsedItem.data.signature);
      const wallets = collectCandidateWallets(parsedItem.data, watchedWallets);
      for (const wallet of wallets) {
        events.push(mapHeliusTxForWallet(parsedItem.data, signature, wallet));
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        skippedInvalid += 1;
        continue;
      }
      throw err;
    }
  }

  return { events, skippedInvalid };
}

export function parseHeliusWebhookPayload(
  payload: unknown,
  watchedWallets: ReadonlySet<WalletAddress>,
): readonly OnChainEvent[] {
  const parsed = HeliusPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError("Malformed Helius webhook payload", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const events: OnChainEvent[] = [];
  for (const tx of parsed.data) {
    const signature = parseTxSignature(tx.signature);
    const wallets = collectCandidateWallets(tx, watchedWallets);
    for (const wallet of wallets) {
      events.push(mapHeliusTxForWallet(tx, signature, wallet));
    }
  }
  return events;
}
