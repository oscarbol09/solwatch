import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import { resolveTokenMetadata, WSOL_MINT } from "../domain/tokens.js";
import {
  type OnChainEvent,
  parseTxSignature,
  type TokenLeg,
  type TxSignature,
  tryParseMintAddress,
  tryParseWalletAddress,
  type WalletAddress,
} from "../domain/types.js";

const UNSIGNED_INT_STRING = /^\d+$/;

const HeliusNativeTransferSchema = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  amount: z.number().nonnegative(),
});

const HeliusTokenTransferSchema = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  mint: z.string(),
  tokenAmount: z.number().nonnegative(),
});

const HeliusRawTokenAmountSchema = z.object({
  tokenAmount: z.string().regex(UNSIGNED_INT_STRING, "Expected non-negative integer string"),
  decimals: z.number().int().min(0).max(18),
});

const HeliusSwapTokenSchema = z.object({
  userAccount: z.string().optional(),
  mint: z.string(),
  rawTokenAmount: HeliusRawTokenAmountSchema,
});

const HeliusSwapNativeSchema = z.object({
  account: z.string().optional(),
  amount: z.string().regex(UNSIGNED_INT_STRING, "Expected non-negative integer string"),
});

const HeliusTransactionSchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  timestamp: z.number().int().min(0).max(8_640_000_000).nullable().optional(),
  fee: z.number().int().nonnegative().default(0),
  feePayer: z.string().optional(),
  type: z.string().default("UNKNOWN"),
  source: z.string().default("UNKNOWN"),
  description: z.string().optional(),
  transactionError: z.unknown().nullable().optional(),
  nativeTransfers: z.array(HeliusNativeTransferSchema).optional(),
  tokenTransfers: z.array(HeliusTokenTransferSchema).optional(),
  events: z
    .object({
      swap: z
        .object({
          nativeInput: HeliusSwapNativeSchema.nullable().optional(),
          nativeOutput: HeliusSwapNativeSchema.nullable().optional(),
          tokenInputs: z.array(HeliusSwapTokenSchema).optional(),
          tokenOutputs: z.array(HeliusSwapTokenSchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

const HeliusPayloadSchema = z.array(HeliusTransactionSchema);

type HeliusTx = z.infer<typeof HeliusTransactionSchema>;
type HeliusSwapEvent = NonNullable<NonNullable<HeliusTx["events"]>["swap"]>;

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
  nativeLeg: { readonly amount: string } | null | undefined,
  tokenLegs: readonly z.infer<typeof HeliusSwapTokenSchema>[] | undefined,
): TokenLeg | null {
  if (nativeLeg && BigInt(nativeLeg.amount) > 0n) {
    return {
      mint: WSOL_MINT,
      symbol: "SOL",
      rawAmount: BigInt(nativeLeg.amount),
      decimals: 9,
    };
  }
  const firstToken = tokenLegs?.[0];
  if (!firstToken) return null;
  const mint = tryParseMintAddress(firstToken.mint);
  if (mint === null) return null;
  const meta = resolveTokenMetadata(mint);
  return {
    mint,
    symbol: meta.symbol,
    rawAmount: BigInt(firstToken.rawTokenAmount.tokenAmount),
    decimals: firstToken.rawTokenAmount.decimals,
  };
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

  if (!success) {
    return {
      kind: "program_interaction",
      signature,
      slot,
      timestampSec,
      wallet,
      programIds: [tx.source],
      summary: tx.description ?? `Failed ${tx.type} via ${tx.source}`,
      feeLamports,
      success: false,
    };
  }

  const swap = tx.events?.swap;
  if (tx.type === "SWAP" && swap && isWalletSwapOwner(tx, swap, wallet)) {
    const tokenIn = buildSwapLegFromHelius(swap.nativeInput, swap.tokenInputs);
    const tokenOut = buildSwapLegFromHelius(swap.nativeOutput, swap.tokenOutputs);
    if (tokenIn && tokenOut) {
      return {
        kind: "dex_swap",
        signature,
        slot,
        timestampSec,
        wallet,
        dex: tx.source,
        programId: tx.source,
        tokenIn,
        tokenOut,
        feeLamports,
        success: true,
      };
    }
  }

  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.tokenAmount <= 0) continue;
    if (tt.toUserAccount !== wallet && tt.fromUserAccount !== wallet) continue;
    const mint = tryParseMintAddress(tt.mint);
    if (mint === null) continue;

    const resolved = resolveTokenMetadata(mint);
    const converted = decimalNumberToBaseUnits(tt.tokenAmount, resolved.decimals);
    const isIncoming = tt.toUserAccount === wallet;
    return {
      kind: "spl_transfer",
      signature,
      slot,
      timestampSec,
      wallet,
      direction: isIncoming ? "in" : "out",
      mint,
      symbol: resolved.symbol,
      rawAmount: converted.rawAmount,
      decimals: converted.decimals,
      counterparty: isIncoming ? (tt.fromUserAccount ?? null) : (tt.toUserAccount ?? null),
      feeLamports,
      success: true,
    };
  }

  const nativeTransfer = (tx.nativeTransfers ?? []).find(
    (nt) => (nt.toUserAccount === wallet || nt.fromUserAccount === wallet) && nt.amount > 0,
  );
  if (nativeTransfer) {
    const isIncoming = nativeTransfer.toUserAccount === wallet;
    return {
      kind: "sol_transfer",
      signature,
      slot,
      timestampSec,
      wallet,
      direction: isIncoming ? "in" : "out",
      counterparty: isIncoming
        ? (nativeTransfer.fromUserAccount ?? null)
        : (nativeTransfer.toUserAccount ?? null),
      lamports: BigInt(Math.trunc(nativeTransfer.amount)),
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
    programIds: [tx.source],
    summary: tx.description ?? `${tx.type} on ${tx.source}`,
    feeLamports,
    success: true,
  };
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
