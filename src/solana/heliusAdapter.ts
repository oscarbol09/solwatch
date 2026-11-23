import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import { resolveTokenMetadata, shortAddress, WSOL_MINT } from "../domain/tokens.js";
import {
  type OnChainEvent,
  parseMintAddress,
  parseTxSignature,
  type TokenLeg,
  type TxSignature,
  tryParseMintAddress,
  tryParseWalletAddress,
  type WalletAddress,
} from "../domain/types.js";

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
  tokenAmount: z.string(),
  decimals: z.number().int().nonnegative(),
});

const HeliusSwapTokenSchema = z.object({
  userAccount: z.string().optional(),
  mint: z.string(),
  rawTokenAmount: HeliusRawTokenAmountSchema,
});

const HeliusSwapNativeSchema = z.object({
  account: z.string().optional(),
  amount: z.string(),
});

const HeliusTransactionSchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative().nullable().optional(),
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

function decimalNumberToBaseUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const plain = value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: decimals,
  });
  const [wholePart = "0", fracPart = ""] = plain.split(".");
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
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

  const matched: WalletAddress[] = [];
  for (const candidate of candidates) {
    const parsed = tryParseWalletAddress(candidate);
    if (parsed !== null && watchedSet.has(parsed)) {
      matched.push(parsed);
    }
  }
  return matched;
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
    decimals: meta.decimals ?? firstToken.rawTokenAmount.decimals,
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
  if (tx.type === "SWAP" && swap) {
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

  const tokenTransfer = (tx.tokenTransfers ?? []).find(
    (tt) => tt.toUserAccount === wallet || tt.fromUserAccount === wallet,
  );
  if (tokenTransfer) {
    const mint = parseMintAddress(tokenTransfer.mint);
    const resolved = resolveTokenMetadata(mint);
    const decimals = resolved.decimals ?? 6;
    const isIncoming = tokenTransfer.toUserAccount === wallet;
    return {
      kind: "spl_transfer",
      signature,
      slot,
      timestampSec,
      wallet,
      direction: isIncoming ? "in" : "out",
      mint,
      symbol: resolved.symbol,
      rawAmount: decimalNumberToBaseUnits(tokenTransfer.tokenAmount, decimals),
      decimals,
      counterparty: isIncoming
        ? (tokenTransfer.fromUserAccount ?? null)
        : (tokenTransfer.toUserAccount ?? null),
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
    summary: tx.description ?? `${tx.type} on ${shortAddress(tx.source)}`,
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
