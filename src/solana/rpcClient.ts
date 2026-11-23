import {
  createSolanaRpc,
  isSolanaError,
  type Signature,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { abortableSleep, computeBackoffDelayMs, parseRetryAfterMs } from "../domain/backoff.js";
import type { RawTokenBalanceEntry, SolanaTransactionInput } from "../domain/classifier.js";
import { RpcError } from "../domain/errors.js";
import {
  type CommitmentLevel,
  parseTxSignature,
  type TxSignature,
  type WalletAddress,
} from "../domain/types.js";

export type SignatureSummary = {
  readonly signature: TxSignature;
  readonly slot: bigint;
  readonly err: unknown;
};

export interface SolanaRpcPort {
  getTransaction(
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<SolanaTransactionInput | null>;
  getSignaturesForAddress(
    address: WalletAddress,
    options?: {
      readonly until?: TxSignature | undefined;
      readonly limit?: number | undefined;
    },
    signal?: AbortSignal,
  ): Promise<readonly SignatureSummary[]>;
}

export type SolanaRpcClientOptions = {
  readonly commitment?: CommitmentLevel | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly nullRetryDelayMs?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

type HttpErrorInfo = {
  readonly statusCode: number;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly message: string;
};

function classifyRpcFailure(err: unknown): HttpErrorInfo {
  if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const statusCode = err.context.statusCode;
    const retryAfterMs = parseRetryAfterMs(err.context.headers.get("retry-after"));
    const retryable = statusCode === 429 || statusCode >= 500;
    return {
      statusCode,
      retryAfterMs,
      retryable,
      message: `Solana RPC HTTP ${statusCode}: ${err.context.message}`,
    };
  }

  if (err instanceof Error) {
    const transientNetwork =
      /fetch failed|network|econnreset|etimedout|eai_again|socket/i.test(err.message) ||
      err.name === "TimeoutError";
    return {
      statusCode: 502,
      retryAfterMs: null,
      retryable: transientNetwork,
      message: err.message,
    };
  }

  return {
    statusCode: 502,
    retryAfterMs: null,
    retryable: false,
    message: String(err),
  };
}

export class SolanaRpcClient implements SolanaRpcPort {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly commitment: "confirmed" | "finalized";
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly nullRetryDelayMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;

  constructor(rpcUrl: string, options: SolanaRpcClientOptions = {}) {
    this.rpc = createSolanaRpc(rpcUrl);
    // Solana JSON-RPC getTransaction and getSignaturesForAddress only accept confirmed/finalized.
    this.commitment = options.commitment === "finalized" ? "finalized" : "confirmed";
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.nullRetryDelayMs = options.nullRetryDelayMs ?? 250;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.rng = options.rng ?? Math.random;
  }

  private fetchRawJsonParsedTransaction(signature: TxSignature, signal?: AbortSignal) {
    return this.withRetry(async (requestSignal) => {
      return this.rpc
        .getTransaction(signature, {
          commitment: this.commitment,
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        })
        .send({ abortSignal: requestSignal });
    }, signal);
  }

  async getTransaction(
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<SolanaTransactionInput | null> {
    const maxNullAttempts = Math.min(this.maxRetries, 2);
    let raw = await this.fetchRawJsonParsedTransaction(signature, signal);

    for (let nullAttempt = 0; nullAttempt < maxNullAttempts && raw === null; nullAttempt += 1) {
      if (signal?.aborted) break;
      await this.sleep(this.nullRetryDelayMs, signal);
      raw = await this.fetchRawJsonParsedTransaction(signature, signal);
    }

    if (raw === null || raw.meta === null) {
      return null;
    }

    const accountKeys = raw.transaction.message.accountKeys.map((entry) => entry.pubkey);
    const programIds = raw.transaction.message.instructions.map((ix) => ix.programId);
    const innerInstructions = (raw.meta.innerInstructions ?? []).flatMap((group) =>
      group.instructions.map((ix) => ix.programId),
    );

    const mapTokenBalance = (
      entry: NonNullable<typeof raw.meta.preTokenBalances>[number],
    ): RawTokenBalanceEntry => ({
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      owner: entry.owner,
      programId: entry.programId,
      uiTokenAmount: {
        amount: entry.uiTokenAmount.amount,
        decimals: entry.uiTokenAmount.decimals,
      },
    });

    return {
      signature,
      slot: BigInt(raw.slot),
      blockTime: raw.blockTime !== null ? Number(raw.blockTime) : null,
      meta: {
        err: raw.meta.err,
        fee: BigInt(raw.meta.fee),
        preBalances: raw.meta.preBalances.map((v) => BigInt(v)),
        postBalances: raw.meta.postBalances.map((v) => BigInt(v)),
        preTokenBalances: raw.meta.preTokenBalances?.map(mapTokenBalance),
        postTokenBalances: raw.meta.postTokenBalances?.map(mapTokenBalance),
        innerInstructions,
      },
      accountKeys,
      programIds,
    };
  }

  async getSignaturesForAddress(
    address: WalletAddress,
    options: {
      readonly until?: TxSignature | undefined;
      readonly limit?: number | undefined;
    } = {},
    signal?: AbortSignal,
  ): Promise<readonly SignatureSummary[]> {
    const rawList = await this.withRetry(async (requestSignal) => {
      const config: {
        commitment: "confirmed" | "finalized";
        limit: number;
        until?: Signature;
      } = {
        commitment: this.commitment,
        limit: options.limit ?? 20,
      };
      if (options.until !== undefined) {
        config.until = options.until;
      }
      return this.rpc.getSignaturesForAddress(address, config).send({ abortSignal: requestSignal });
    }, signal);

    return rawList.map((entry) => ({
      signature: parseTxSignature(entry.signature),
      slot: BigInt(entry.slot),
      err: entry.err,
    }));
  }

  private async withRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (callerSignal?.aborted) {
        throw new RpcError("Solana RPC request aborted", {
          retryable: false,
          statusCode: 499,
          cause: callerSignal.reason,
        });
      }

      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;

      try {
        return await operation(requestSignal);
      } catch (err) {
        if (callerSignal?.aborted) {
          throw new RpcError("Solana RPC request aborted", {
            retryable: false,
            statusCode: 499,
            cause: err,
          });
        }

        const classified = classifyRpcFailure(err);
        const canRetry = classified.retryable && attempt < this.maxRetries;
        if (!canRetry) {
          throw new RpcError(classified.message, {
            retryable: classified.retryable,
            statusCode: classified.statusCode,
            cause: err,
          });
        }

        const delayMs =
          classified.retryAfterMs ??
          computeBackoffDelayMs(
            attempt,
            { baseMs: this.baseBackoffMs, maxMs: this.maxBackoffMs },
            this.rng,
          );
        await this.sleep(delayMs, callerSignal);
      }
    }

    throw new RpcError("Exhausted Solana RPC retry budget", { retryable: true, statusCode: 502 });
  }
}
