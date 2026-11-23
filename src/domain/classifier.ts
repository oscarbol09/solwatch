import { resolveTokenMetadata, shortAddress, WSOL_MINT } from "./tokens.js";
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
};

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const INFRA_PROGRAMS = new Set<string>([
  COMPUTE_BUDGET_PROGRAM,
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

// Ordered by aggregation hierarchy so Jupiter routes take precedence over underlying AMM CPIs.
const DEX_PROGRAMS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", name: "Jupiter" },
  { id: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", name: "Jupiter v4" },
  { id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", name: "Raydium" },
  { id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", name: "Raydium CLMM" },
  { id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", name: "Raydium CPMM" },
  { id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", name: "Orca Whirlpool" },
  { id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", name: "Meteora DLMM" },
  { id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", name: "Pump.fun" },
  { id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", name: "PumpSwap" },
];

type TokenOwnerDelta = {
  readonly owner: string;
  readonly mint: MintAddress;
  readonly symbol: string;
  readonly decimals: number;
  readonly delta: bigint;
};

type SignedLeg = TokenLeg & { readonly delta: bigint };

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
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
): { readonly id: string; readonly name: string } | null {
  const invoked = new Set(programIds);
  for (const candidate of DEX_PROGRAMS) {
    if (invoked.has(candidate.id)) {
      return candidate;
    }
  }
  return null;
}

function computeTokenDeltas(tx: SolanaTransactionInput): readonly TokenOwnerDelta[] {
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
      const owner = entry.owner ?? tx.accountKeys[entry.accountIndex];
      if (!owner) continue;
      const mint = tryParseMintAddress(entry.mint);
      if (mint === null) continue;
      const key = `${owner}:${mint}`;
      const existing = buckets.get(key) ?? {
        owner,
        mint,
        decimals: entry.uiTokenAmount.decimals,
        pre: 0n,
        post: 0n,
      };
      const amount = BigInt(entry.uiTokenAmount.amount);
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
    if (!candidate || candidate === watchedWallet || INFRA_PROGRAMS.has(candidate)) continue;
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

function pickLargestLeg(legs: readonly SignedLeg[]): SignedLeg | undefined {
  let best: SignedLeg | undefined;
  for (const leg of legs) {
    if (!best || leg.rawAmount > best.rawAmount) {
      best = leg;
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
      summary: `Transaction failed (${nonBudgetPrograms.map(shortAddress).join(", ") || "unknown"})`,
      feeLamports,
      success: false,
    };
  }

  const netSolDelta = computeNetSolDelta(tx, watchedWallet, feeLamports);
  const allTokenDeltas = computeTokenDeltas(tx);
  const walletTokenDeltas = allTokenDeltas.filter((d) => d.owner === watchedWallet);

  const spentLegs: SignedLeg[] = [];
  const receivedLegs: SignedLeg[] = [];

  for (const item of walletTokenDeltas) {
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

  const hasWsolSpent = spentLegs.some((l) => l.mint === WSOL_MINT);
  const hasWsolReceived = receivedLegs.some((l) => l.mint === WSOL_MINT);

  if (netSolDelta < 0n && !hasWsolSpent) {
    spentLegs.push({
      mint: WSOL_MINT,
      symbol: "SOL",
      rawAmount: -netSolDelta,
      decimals: 9,
      delta: netSolDelta,
    });
  } else if (netSolDelta > 0n && !hasWsolReceived) {
    receivedLegs.push({
      mint: WSOL_MINT,
      symbol: "SOL",
      rawAmount: netSolDelta,
      decimals: 9,
      delta: netSolDelta,
    });
  }

  const dexProgram = findDexProgram(programIds);
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

  if (walletTokenDeltas.length > 0) {
    let primary = walletTokenDeltas[0];
    for (const item of walletTokenDeltas) {
      if (primary && absBigInt(item.delta) > absBigInt(primary.delta)) {
        primary = item;
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

  if (netSolDelta !== 0n) {
    return {
      kind: "sol_transfer",
      signature,
      slot: tx.slot,
      timestampSec: tx.blockTime,
      wallet: watchedWallet,
      direction: netSolDelta >= 0n ? "in" : "out",
      counterparty: findSolCounterparty(tx, watchedWallet, netSolDelta, feeLamports),
      lamports: absBigInt(netSolDelta),
      feeLamports,
      success: true,
    };
  }

  const labelPrograms = nonBudgetPrograms.filter((p) => !INFRA_PROGRAMS.has(p)).map(shortAddress);
  const summaryTarget =
    labelPrograms.length > 0
      ? labelPrograms.join(", ")
      : nonBudgetPrograms.map(shortAddress).join(", ");

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
