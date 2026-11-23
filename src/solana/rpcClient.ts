import {
  createSolanaRpc,
  isSolanaError,
  type Signature,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_EPOCH_REWARDS_PERIOD_ACTIVE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  address as solanaAddress,
} from "@solana/kit";
import { abortableSleep, computeBackoffDelayMs, parseRetryAfterMs } from "../domain/backoff.js";
import type {
  ParsedInstructionHint,
  RawTokenBalanceEntry,
  SolanaTransactionInput,
} from "../domain/classifier.js";
import { RpcError } from "../domain/errors.js";
import {
  type CommitmentLevel,
  parseTxSignature,
  type TxSignature,
  tryParseWalletAddress,
  type WalletAddress,
} from "../domain/types.js";

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const RETRYABLE_JSON_RPC_CODES = new Set<number>([
  -32004, -32005, -32007, -32009, -32014, -32016, -32019, -32429, -32603,
]);

export type SignatureSummary = {
  readonly signature: TxSignature;
  readonly slot: bigint;
  readonly err: unknown;
};

export type GetSignaturesForAddressOptions = {
  readonly until?: TxSignature | undefined;
  readonly before?: TxSignature | undefined;
  readonly limit?: number | undefined;
};

export interface SolanaRpcPort {
  getTransaction(
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<SolanaTransactionInput | null>;
  getSignaturesForAddress(
    address: WalletAddress,
    options?: GetSignaturesForAddressOptions,
    signal?: AbortSignal,
  ): Promise<readonly SignatureSummary[]>;
  getTokenAccountsByOwner?(
    owner: WalletAddress,
    signal?: AbortSignal,
  ): Promise<readonly WalletAddress[]>;
}

export type SolanaRpcClientOptions = {
  readonly commitment?: CommitmentLevel | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly maxNullAttempts?: number | undefined;
  readonly nullRetryDelayMs?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly txCacheTtlMs?: number | undefined;
  readonly txCacheMaxEntries?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly rng?: (() => number) | undefined;
};

type HttpErrorInfo = {
  readonly statusCode: number;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly message: string;
};

class AsyncSemaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new RpcError("Solana RPC request aborted", {
        retryable: false,
        statusCode: 499,
        cause: signal.reason,
      });
    }

    if (this.active < this.max) {
      this.active += 1;
      return this.releaseOnce();
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const grant = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(grant);
        if (idx >= 0) this.waiters.splice(idx, 1);
        cleanup();
        reject(
          new RpcError("Solana RPC request aborted", {
            retryable: false,
            statusCode: 499,
            cause: signal?.reason,
          }),
        );
      };

      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractParsedInstructionHint(ix: unknown): ParsedInstructionHint | null {
  if (!isRecord(ix)) return null;
  const programId = ix.programId;
  const parsed = ix.parsed;
  if (typeof programId !== "string" || !isRecord(parsed)) return null;
  const type = parsed.type;
  const info = parsed.info;
  if (typeof type !== "string" || !isRecord(info)) return null;
  return { programId, type, info };
}

function isRetryableJsonRpcSolanaError(err: unknown): boolean {
  return (
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED) ||
    isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_EPOCH_REWARDS_PERIOD_ACTIVE)
  );
}

function extractNumericRpcCode(err: unknown): number | null {
  if (!isRecord(err)) return null;
  if (typeof err.code === "number") return err.code;
  if (isRecord(err.context) && typeof err.context.code === "number") return err.context.code;
  if (isRecord(err.cause)) return extractNumericRpcCode(err.cause);
  return null;
}

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

  if (isRetryableJsonRpcSolanaError(err)) {
    return {
      statusCode: 503,
      retryAfterMs: null,
      retryable: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const rpcCode = extractNumericRpcCode(err);
  if (rpcCode !== null && RETRYABLE_JSON_RPC_CODES.has(rpcCode)) {
    return {
      statusCode: rpcCode === -32429 ? 429 : 503,
      retryAfterMs: null,
      retryable: true,
      message: err instanceof Error ? err.message : `Solana JSON-RPC error ${rpcCode}`,
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

type CachedTxEntry = {
  readonly expiresAtMs: number;
  readonly value: SolanaTransactionInput;
};

type InFlightTxEntry = {
  readonly promise: Promise<SolanaTransactionInput | null>;
  readonly controller: AbortController;
  waiters: number;
};

export class SolanaRpcClient implements SolanaRpcPort {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly commitment: "confirmed" | "finalized";
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxNullAttempts: number;
  private readonly nullRetryDelayMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly semaphore: AsyncSemaphore;
  private readonly txCacheTtlMs: number;
  private readonly txCacheMaxEntries: number;
  private readonly txCache = new Map<TxSignature, CachedTxEntry>();
  private readonly inFlightTx = new Map<TxSignature, InFlightTxEntry>();
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;

  constructor(rpcUrl: string, options: SolanaRpcClientOptions = {}) {
    this.rpc = createSolanaRpc(rpcUrl);
    // Solana JSON-RPC getTransaction and getSignaturesForAddress only accept confirmed/finalized.
    this.commitment = options.commitment === "finalized" ? "finalized" : "confirmed";
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxNullAttempts = options.maxNullAttempts ?? Math.min(this.maxRetries, 2);
    this.nullRetryDelayMs = options.nullRetryDelayMs ?? 250;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.semaphore = new AsyncSemaphore(options.maxConcurrency ?? 8);
    this.txCacheTtlMs = options.txCacheTtlMs ?? 30_000;
    this.txCacheMaxEntries = options.txCacheMaxEntries ?? 512;
    this.nowMs = options.nowMs ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.rng = options.rng ?? Math.random;
  }

  private getCachedTx(signature: TxSignature): SolanaTransactionInput | undefined {
    if (this.txCacheTtlMs <= 0) return undefined;
    const entry = this.txCache.get(signature);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.txCache.delete(signature);
      return undefined;
    }
    // Refresh LRU order
    this.txCache.delete(signature);
    this.txCache.set(signature, entry);
    return entry.value;
  }

  private setCachedTx(signature: TxSignature, value: SolanaTransactionInput): void {
    if (this.txCacheTtlMs <= 0 || this.txCacheMaxEntries <= 0) return;
    if (this.txCache.has(signature)) {
      this.txCache.delete(signature);
    } else if (this.txCache.size >= this.txCacheMaxEntries) {
      const oldestKey = this.txCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.txCache.delete(oldestKey);
      }
    }
    this.txCache.set(signature, {
      expiresAtMs: this.nowMs() + this.txCacheTtlMs,
      value,
    });
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

  private async fetchAndNormalizeTransaction(
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<SolanaTransactionInput | null> {
    let raw = await this.fetchRawJsonParsedTransaction(signature, signal);

    for (
      let nullAttempt = 0;
      nullAttempt < this.maxNullAttempts && raw === null;
      nullAttempt += 1
    ) {
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

    const parsedInstructions: ParsedInstructionHint[] = [];
    for (const ix of raw.transaction.message.instructions) {
      const hint = extractParsedInstructionHint(ix);
      if (hint) parsedInstructions.push(hint);
    }
    for (const group of raw.meta.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        const hint = extractParsedInstructionHint(ix);
        if (hint) parsedInstructions.push(hint);
      }
    }

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

    const normalized: SolanaTransactionInput = {
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
      parsedInstructions,
    };

    this.setCachedTx(signature, normalized);
    return normalized;
  }

  async getTransaction(
    signature: TxSignature,
    signal?: AbortSignal,
  ): Promise<SolanaTransactionInput | null> {
    if (signal?.aborted) {
      throw new RpcError("Solana RPC request aborted", {
        retryable: false,
        statusCode: 499,
        cause: signal.reason,
      });
    }

    const cached = this.getCachedTx(signature);
    if (cached !== undefined) {
      return cached;
    }

    let inFlight = this.inFlightTx.get(signature);
    if (!inFlight) {
      const controller = new AbortController();
      const promise = this.fetchAndNormalizeTransaction(signature, controller.signal).finally(
        () => {
          if (this.inFlightTx.get(signature) === inFlight) {
            this.inFlightTx.delete(signature);
          }
        },
      );
      inFlight = { promise, controller, waiters: 0 };
      this.inFlightTx.set(signature, inFlight);
    }

    inFlight.waiters += 1;
    const entry = inFlight;

    return await new Promise<SolanaTransactionInput | null>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const releaseWaiter = () => {
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (entry.waiters === 0) {
          entry.controller.abort(new Error("All callers aborted"));
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseWaiter();
        reject(
          new RpcError("Solana RPC request aborted", {
            retryable: false,
            statusCode: 499,
            cause: signal?.reason,
          }),
        );
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      entry.promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          entry.waiters = Math.max(0, entry.waiters - 1);
          resolve(result);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          entry.waiters = Math.max(0, entry.waiters - 1);
          reject(err);
        },
      );
    });
  }

  async getSignaturesForAddress(
    address: WalletAddress,
    options: GetSignaturesForAddressOptions = {},
    signal?: AbortSignal,
  ): Promise<readonly SignatureSummary[]> {
    const clampedLimit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 20)));
    const rawList = await this.withRetry(async (requestSignal) => {
      const baseConfig: {
        commitment: "confirmed" | "finalized";
        limit: number;
        until?: Signature;
      } = {
        commitment: this.commitment,
        limit: clampedLimit,
      };
      if (options.until !== undefined) {
        baseConfig.until = options.until;
      }
      if (options.before !== undefined) {
        return this.rpc
          .getSignaturesForAddress(address, { ...baseConfig, before: options.before })
          .send({ abortSignal: requestSignal });
      }
      return this.rpc
        .getSignaturesForAddress(address, baseConfig)
        .send({ abortSignal: requestSignal });
    }, signal);

    return rawList.map((entry) => ({
      signature: parseTxSignature(entry.signature),
      slot: BigInt(entry.slot),
      err: entry.err,
    }));
  }

  async getTokenAccountsByOwner(
    owner: WalletAddress,
    signal?: AbortSignal,
  ): Promise<readonly WalletAddress[]> {
    const queryProgram = (programIdStr: string) =>
      this.withRetry(async (requestSignal) => {
        return this.rpc
          .getTokenAccountsByOwner(
            owner,
            { programId: solanaAddress(programIdStr) },
            {
              commitment: this.commitment,
              encoding: "base64",
              dataSlice: { offset: 0, length: 0 },
            },
          )
          .send({ abortSignal: requestSignal });
      }, signal);

    const [splResp, token2022Resp] = await Promise.all([
      queryProgram(SPL_TOKEN_PROGRAM_ID),
      queryProgram(TOKEN_2022_PROGRAM_ID),
    ]);

    const seen = new Set<WalletAddress>();
    const accounts: WalletAddress[] = [];
    for (const item of [...splResp.value, ...token2022Resp.value]) {
      const parsed = tryParseWalletAddress(item.pubkey);
      if (parsed !== null && !seen.has(parsed)) {
        seen.add(parsed);
        accounts.push(parsed);
      }
    }
    return accounts;
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
        const release = await this.semaphore.acquire(callerSignal);
        try {
          return await operation(requestSignal);
        } finally {
          release();
        }
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
