import { formatUnits, resolveTokenMetadata, shortAddress, WSOL_MINT } from "./tokens.js";
import {
  type MintAddress,
  type OnChainEvent,
  parseTxSignature,
  type TokenLeg,
  tryParseMintAddress,
  type WalletAddress,
} from "./types.js";

export type RawTokenBalanceEntry = {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string | undefined;
  readonly programId?: string | undefined;
  readonly uiTokenAmount: {
    readonly amount: string;
    readonly decimals: number;
  };
};

export type ParsedInstructionHint = {
  readonly programId: string;
  readonly type: string;
  readonly info: Readonly<Record<string, unknown>>;
};

export type SolanaTransactionInput = {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly fee: bigint;
    readonly preBalances: readonly bigint[];
    readonly postBalances: readonly bigint[];
    readonly preTokenBalances?: readonly RawTokenBalanceEntry[] | undefined;
    readonly postTokenBalances?: readonly RawTokenBalanceEntry[] | undefined;
    readonly innerInstructions?: readonly string[] | undefined;
  };
  readonly accountKeys: readonly string[];
  readonly programIds: readonly string[];
  readonly parsedInstructions?: readonly ParsedInstructionHint[] | undefined;
};

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const JITO_TIP_ACCOUNTS = new Set<string>([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

const KNOWN_PROGRAM_NAMES = new Map<string, string>([
  ["11111111111111111111111111111111", "System"],
  [COMPUTE_BUDGET_PROGRAM, "ComputeBudget"],
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "SPL Token"],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "Token-2022"],
  [ASSOCIATED_TOKEN_PROGRAM, "Associated Token"],
  ["Stake11111111111111111111111111111111111111", "Stake"],
  ["Vote111111111111111111111111111111111111111", "Vote"],
]);

const INFRA_PROGRAMS = new Set<string>([
  COMPUTE_BUDGET_PROGRAM,
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN_PROGRAM,
]);

// Ordered by aggregation hierarchy so Jupiter/OKX routes take precedence over underlying AMM CPIs.
const DEX_PROGRAMS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly isAmm: boolean;
}> = [
  { id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", name: "Jupiter", isAmm: false },
  { id: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", name: "Jupiter v4", isAmm: false },
  { id: "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma", name: "OKX Router", isAmm: false },
  { id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", name: "Raydium", isAmm: true },
  { id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", name: "Raydium CLMM", isAmm: true },
  { id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", name: "Raydium CPMM", isAmm: true },
  { id: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", name: "Raydium LaunchLab", isAmm: false },
  { id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", name: "Orca Whirlpool", isAmm: true },
  { id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", name: "Meteora DLMM", isAmm: true },
  { id: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", name: "Meteora Pools", isAmm: true },
  { id: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", name: "Meteora DAMM v2", isAmm: true },
  { id: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", name: "Phoenix", isAmm: false },
  { id: "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb", name: "OpenBook v2", isAmm: false },
  { id: "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", name: "Lifinity v2", isAmm: true },
  { id: "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx", name: "Sanctum", isAmm: false },
  { id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", name: "Pump.fun", isAmm: false },
  { id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", name: "PumpSwap", isAmm: true },
];

const NFT_MARKETPLACE_PROGRAMS = new Map<string, string>([
  ["TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN", "Tensor"],
  ["TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp", "Tensor cNFT"],
  ["M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", "Magic Eden v2"],
]);

type TokenOwnerDelta = {
  readonly owner: string;
  readonly mint: MintAddress;
  readonly symbol: string;
  readonly decimals: number;
  readonly delta: bigint;
};

type SignedLeg = TokenLeg & { readonly delta: bigint };

const MAX_ATA_RENT_DUST_LAMPORTS = 5_000_000n;

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function safeParseUnsignedBigInt(raw: string): bigint | null {
  return /^\d+$/.test(raw) ? BigInt(raw) : null;
}

export function resolveProgramLabel(programId: string): string {
  const known = KNOWN_PROGRAM_NAMES.get(programId);
  if (known !== undefined) return known;
  const dex = DEX_PROGRAMS.find((d) => d.id === programId);
  if (dex !== undefined) return dex.name;
  const nft = NFT_MARKETPLACE_PROGRAMS.get(programId);
  if (nft !== undefined) return nft;
  return shortAddress(programId);
}

function collectProgramIds(tx: SolanaTransactionInput): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...tx.programIds, ...(tx.meta.innerInstructions ?? [])]) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

function findDexProgram(
  programIds: readonly string[],
): { readonly id: string; readonly name: string; readonly isAmm: boolean } | null {
  const invoked = new Set(programIds);
  for (const candidate of DEX_PROGRAMS) {
    if (invoked.has(candidate.id)) {
      return candidate;
    }
  }
  return null;
}

function findNftMarketplace(programIds: readonly string[]): string | null {
  for (const id of programIds) {
    const label = NFT_MARKETPLACE_PROGRAMS.get(id);
    if (label !== undefined) return label;
  }
  return null;
}

function parseInstructionAdjustments(
  tx: SolanaTransactionInput,
  watchedWallet: WalletAddress,
): { readonly jitoTipLamports: bigint; readonly hasCloseAccountForWallet: boolean } {
  let jitoTipLamports = 0n;
  let hasCloseAccountForWallet = false;

  for (const ix of tx.parsedInstructions ?? []) {
    if (ix.type === "transfer") {
      const source = ix.info.source;
      const dest = ix.info.destination;
      const lamportsRaw = ix.info.lamports;
      if (
        source === watchedWallet &&
        typeof dest === "string" &&
        JITO_TIP_ACCOUNTS.has(dest) &&
        (typeof lamportsRaw === "number" ||
          typeof lamportsRaw === "bigint" ||
          typeof lamportsRaw === "string")
      ) {
        const parsed =
          typeof lamportsRaw === "bigint"
            ? lamportsRaw
            : typeof lamportsRaw === "number" &&
                Number.isSafeInteger(lamportsRaw) &&
                lamportsRaw >= 0
              ? BigInt(lamportsRaw)
              : typeof lamportsRaw === "string"
                ? safeParseUnsignedBigInt(lamportsRaw)
                : null;
        if (parsed !== null && parsed > 0n) {
          jitoTipLamports += parsed;
        }
      }
    } else if (ix.type === "closeAccount" && ix.info.destination === watchedWallet) {
      hasCloseAccountForWallet = true;
    }
  }

  return { jitoTipLamports, hasCloseAccountForWallet };
}

function computeTokenDeltas(tx: SolanaTransactionInput): readonly TokenOwnerDelta[] {
  const ownerByAccountIndex = new Map<number, string>();
  for (const entry of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    if (entry.owner) {
      ownerByAccountIndex.set(entry.accountIndex, entry.owner);
    }
  }

  type Bucket = {
    owner: string;
    mint: MintAddress;
    decimals: number;
    pre: bigint;
    post: bigint;
  };
  const buckets = new Map<string, Bucket>();

  const ingest = (entries: readonly RawTokenBalanceEntry[] | undefined, side: "pre" | "post") => {
    if (!entries) return;
    for (const entry of entries) {
      const owner =
        entry.owner ??
        ownerByAccountIndex.get(entry.accountIndex) ??
        tx.accountKeys[entry.accountIndex];
      if (!owner) continue;
      const mint = tryParseMintAddress(entry.mint);
      if (mint === null) continue;
      const amount = safeParseUnsignedBigInt(entry.uiTokenAmount.amount);
      if (amount === null) continue;

      const key = `${owner}:${mint}`;
      const existing = buckets.get(key) ?? {
        owner,
        mint,
        decimals: entry.uiTokenAmount.decimals,
        pre: 0n,
        post: 0n,
      };
      if (side === "pre") {
        existing.pre += amount;
      } else {
        existing.post += amount;
        existing.decimals = entry.uiTokenAmount.decimals;
      }
      buckets.set(key, existing);
    }
  };

  ingest(tx.meta.preTokenBalances, "pre");
  ingest(tx.meta.postTokenBalances, "post");

  const deltas: TokenOwnerDelta[] = [];
  for (const bucket of buckets.values()) {
    const delta = bucket.post - bucket.pre;
    if (delta !== 0n) {
      const resolved = resolveTokenMetadata(bucket.mint);
      deltas.push({
        owner: bucket.owner,
        mint: bucket.mint,
        symbol: resolved.symbol,
        decimals: resolved.decimals ?? bucket.decimals,
        delta,
      });
    }
  }
  return deltas;
}

function computeNetSolDelta(
  tx: SolanaTransactionInput,
  accountAddress: string,
  feeLamports: bigint,
): bigint {
  const idx = tx.accountKeys.indexOf(accountAddress);
  if (idx < 0) return 0n;
  const pre = tx.meta.preBalances[idx] ?? 0n;
  const post = tx.meta.postBalances[idx] ?? 0n;
  const rawDelta = post - pre;
  const feePayer = tx.accountKeys[0];
  return feePayer === accountAddress ? rawDelta + feeLamports : rawDelta;
}

function findSolCounterparty(
  tx: SolanaTransactionInput,
  watchedWallet: WalletAddress,
  walletNetDelta: bigint,
  feeLamports: bigint,
): string | null {
  const wantPositive = walletNetDelta < 0n;
  let bestAddress: string | null = null;
  let bestMagnitude = 0n;

  for (let i = 0; i < tx.accountKeys.length; i += 1) {
    const candidate = tx.accountKeys[i];
    if (
      !candidate ||
      candidate === watchedWallet ||
      INFRA_PROGRAMS.has(candidate) ||
      JITO_TIP_ACCOUNTS.has(candidate)
    ) {
      continue;
    }
    const pre = tx.meta.preBalances[i] ?? 0n;
    const post = tx.meta.postBalances[i] ?? 0n;
    const rawDelta = post - pre;
    const netDelta = i === 0 ? rawDelta + feeLamports : rawDelta;
    if (wantPositive ? netDelta > 0n : netDelta < 0n) {
      const mag = absBigInt(netDelta);
      if (mag > bestMagnitude) {
        bestMagnitude = mag;
        bestAddress = candidate;
      }
    }
  }

  return bestAddress;
}

function findSplCounterparty(
  allDeltas: readonly TokenOwnerDelta[],
  watchedWallet: WalletAddress,
  primary: TokenOwnerDelta,
): string | null {
  const wantPositive = primary.delta < 0n;
  let bestOwner: string | null = null;
  let bestMag = 0n;

  for (const item of allDeltas) {
    if (item.owner === watchedWallet || item.mint !== primary.mint) continue;
    if (wantPositive ? item.delta > 0n : item.delta < 0n) {
      const mag = absBigInt(item.delta);
      if (mag > bestMag) {
        bestMag = mag;
        bestOwner = item.owner;
      }
    }
  }
  return bestOwner;
}

export function normalizeTokenScale18(rawAmount: bigint, decimals: number): bigint {
  if (decimals <= 18) {
    return rawAmount * 10n ** BigInt(18 - decimals);
  }
  return rawAmount / 10n ** BigInt(decimals - 18);
}

function pickLargestLeg(legs: readonly SignedLeg[]): SignedLeg | undefined {
  const nonDustSplLegs = legs.filter(
    (leg) => leg.mint !== WSOL_MINT || leg.rawAmount > MAX_ATA_RENT_DUST_LAMPORTS,
  );
  const candidates = nonDustSplLegs.length > 0 ? nonDustSplLegs : legs;

  let best: SignedLeg | undefined;
  let bestScaled = -1n;
  for (const leg of candidates) {
    const scaled = normalizeTokenScale18(leg.rawAmount, leg.decimals);
    if (!best || scaled > bestScaled) {
      best = leg;
      bestScaled = scaled;
    }
  }
  return best;
}

export function classifyParsedTransaction(
  tx: SolanaTransactionInput,
  watchedWallet: WalletAddress,
): OnChainEvent {
  const signature = parseTxSignature(tx.signature);
  const feeLamports = tx.meta.fee;
  const success = tx.meta.err === null;
  const programIds = collectProgramIds(tx);
  const nonBudgetPrograms = programIds.filter((id) => id !== COMPUTE_BUDGET_PROGRAM);

  if (!success) {
    return {
      kind: "program_interaction",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      programIds,
      summary: `Transaction failed (${nonBudgetPrograms.map(resolveProgramLabel).join(", ") || "unknown"})`,
      feeLamports,
      success: false,
    };
  }

  const rawNetSolDelta = computeNetSolDelta(tx, watchedWallet, feeLamports);
  const { jitoTipLamports, hasCloseAccountForWallet } = parseInstructionAdjustments(
    tx,
    watchedWallet,
  );
  const adjustedSolDelta =
    jitoTipLamports > 0n && rawNetSolDelta < 0n
      ? rawNetSolDelta + minBigInt(jitoTipLamports, -rawNetSolDelta)
      : rawNetSolDelta;

  const allTokenDeltas = computeTokenDeltas(tx);
  const walletTokenDeltas = allTokenDeltas.filter((d) => d.owner === watchedWallet);

  const wsolDelta = walletTokenDeltas
    .filter((d) => d.mint === WSOL_MINT)
    .reduce((acc, d) => acc + d.delta, 0n);
  const nonWsolDeltas = walletTokenDeltas.filter((d) => d.mint !== WSOL_MINT);
  const dexProgram = findDexProgram(programIds);

  // Detect pure WSOL wrap / unwrap operations (opposing native SOL and WSOL deltas canceling out).
  if (
    wsolDelta !== 0n &&
    nonWsolDeltas.length === 0 &&
    !dexProgram &&
    adjustedSolDelta !== 0n &&
    wsolDelta > 0n !== adjustedSolDelta > 0n &&
    absBigInt(adjustedSolDelta + wsolDelta) <= MAX_ATA_RENT_DUST_LAMPORTS
  ) {
    const label = wsolDelta < 0n ? "Unwrapped" : "Wrapped";
    return {
      kind: "program_interaction",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      programIds,
      summary: `${label} ${formatUnits(absBigInt(wsolDelta), 9, 6)} SOL`,
      feeLamports,
      success: true,
    };
  }

  // Detect pure SPL closeAccount rent reclaim so reclaimed ~0.002039 SOL is not misreported as a deposit.
  if (
    nonWsolDeltas.length === 0 &&
    wsolDelta === 0n &&
    hasCloseAccountForWallet &&
    adjustedSolDelta > 0n &&
    adjustedSolDelta <= MAX_ATA_RENT_DUST_LAMPORTS
  ) {
    return {
      kind: "program_interaction",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      programIds,
      summary: `Closed token account (reclaimed ${formatUnits(adjustedSolDelta, 9, 6)} SOL rent)`,
      feeLamports,
      success: true,
    };
  }

  const combinedSolDelta = adjustedSolDelta + wsolDelta;

  const spentLegs: SignedLeg[] = [];
  const receivedLegs: SignedLeg[] = [];

  for (const item of nonWsolDeltas) {
    const leg: SignedLeg = {
      mint: item.mint,
      symbol: item.symbol,
      rawAmount: absBigInt(item.delta),
      decimals: item.decimals,
      delta: item.delta,
    };
    if (item.delta < 0n) {
      spentLegs.push(leg);
    } else {
      receivedLegs.push(leg);
    }
  }

  if (combinedSolDelta !== 0n) {
    const solLeg: SignedLeg = {
      mint: WSOL_MINT,
      symbol: "SOL",
      rawAmount: absBigInt(combinedSolDelta),
      decimals: 9,
      delta: combinedSolDelta,
    };
    if (combinedSolDelta < 0n) {
      spentLegs.push(solLeg);
    } else {
      receivedLegs.push(solLeg);
    }
  }

  const significantSpent = spentLegs.filter(
    (leg) => leg.mint !== WSOL_MINT || leg.rawAmount > MAX_ATA_RENT_DUST_LAMPORTS,
  );
  const significantReceived = receivedLegs.filter(
    (leg) => leg.mint !== WSOL_MINT || leg.rawAmount > MAX_ATA_RENT_DUST_LAMPORTS,
  );

  // Disambiguate AMM LP deposits/withdrawals (e.g., 2 tokens spent -> 1 LP token minted) from swaps.
  if (
    dexProgram?.isAmm &&
    ((significantSpent.length >= 2 && significantReceived.length === 1) ||
      (significantSpent.length === 1 && significantReceived.length >= 2))
  ) {
    const action =
      significantSpent.length >= 2
        ? `Liquidity provision on ${dexProgram.name}`
        : `Liquidity removal on ${dexProgram.name}`;
    return {
      kind: "program_interaction",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      programIds,
      summary: action,
      feeLamports,
      success: true,
    };
  }

  const tokenIn = pickLargestLeg(spentLegs);
  const tokenOut = pickLargestLeg(receivedLegs);

  if (tokenIn && tokenOut && tokenIn.mint !== tokenOut.mint && dexProgram) {
    return {
      kind: "dex_swap",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      dex: dexProgram.name,
      programId: dexProgram.id,
      tokenIn: {
        mint: tokenIn.mint,
        symbol: tokenIn.symbol,
        rawAmount: tokenIn.rawAmount,
        decimals: tokenIn.decimals,
      },
      tokenOut: {
        mint: tokenOut.mint,
        symbol: tokenOut.symbol,
        rawAmount: tokenOut.rawAmount,
        decimals: tokenOut.decimals,
      },
      feeLamports,
      success: true,
    };
  }

  // Clarify NFT purchases/sales where SOL spent/received accompanies a 0-decimal token delta.
  const nftMarketplace = findNftMarketplace(programIds);
  if (
    nonWsolDeltas.length === 1 &&
    nonWsolDeltas[0]?.decimals === 0 &&
    absBigInt(nonWsolDeltas[0].delta) === 1n &&
    absBigInt(combinedSolDelta) > MAX_ATA_RENT_DUST_LAMPORTS &&
    (nftMarketplace !== null || nonWsolDeltas[0].delta > 0n !== combinedSolDelta > 0n)
  ) {
    const nftDelta = nonWsolDeltas[0];
    const verb = nftDelta.delta > 0n ? "Purchased" : "Sold";
    const solWord = nftDelta.delta > 0n ? "for" : "for +";
    const venue = nftMarketplace ? ` on ${nftMarketplace}` : "";
    return {
      kind: "program_interaction",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      programIds,
      summary: `${verb} NFT ${nftDelta.symbol} ${solWord} ${formatUnits(absBigInt(combinedSolDelta), 9, 4)} SOL${venue}`,
      feeLamports,
      success: true,
    };
  }

  const transferCandidates = nonWsolDeltas.length > 0 ? nonWsolDeltas : walletTokenDeltas;
  if (transferCandidates.length > 0) {
    let primary = transferCandidates[0];
    let bestScaled = primary
      ? normalizeTokenScale18(absBigInt(primary.delta), primary.decimals)
      : -1n;
    for (const item of transferCandidates) {
      const scaled = normalizeTokenScale18(absBigInt(item.delta), item.decimals);
      if (!primary || scaled > bestScaled) {
        primary = item;
        bestScaled = scaled;
      }
    }
    if (primary) {
      return {
        kind: "spl_transfer",
        signature,
        slot: tx.slot,
        timestampSec: tx.blockTime,
        wallet: watchedWallet,
        direction: primary.delta >= 0n ? "in" : "out",
        mint: primary.mint,
        symbol: primary.symbol,
        rawAmount: absBigInt(primary.delta),
        decimals: primary.decimals,
        counterparty: findSplCounterparty(allTokenDeltas, watchedWallet, primary),
        feeLamports,
        success: true,
      };
    }
  }

  if (adjustedSolDelta !== 0n) {
    return {
      kind: "sol_transfer",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      direction: adjustedSolDelta >= 0n ? "in" : "out",
      counterparty: findSolCounterparty(tx, watchedWallet, adjustedSolDelta, feeLamports),
      lamports: absBigInt(adjustedSolDelta),
      feeLamports,
      success: true,
    };
  }

  const labelPrograms = nonBudgetPrograms
    .filter((p) => !INFRA_PROGRAMS.has(p))
    .map(resolveProgramLabel);
  const summaryTarget =
    labelPrograms.length > 0
      ? labelPrograms.join(", ")
      : nonBudgetPrograms.map(resolveProgramLabel).join(", ");

  return {
    kind: "program_interaction",
    signature,
    slot: tx.slot,
    timestampSec: tx.blockTime,
    wallet: watchedWallet,
    programIds,
    summary: `Invoked ${summaryTarget || "Solana program"}`,
    feeLamports,
    success: true,
  };
}
