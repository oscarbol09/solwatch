import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcError } from "../../src/domain/errors.js";
import { USDC_MINT } from "../../src/domain/tokens.js";
import { parseTxSignature, parseWalletAddress } from "../../src/domain/types.js";
import { SolanaRpcClient } from "../../src/solana/rpcClient.js";
import {
  COUNTERPARTY_WALLET,
  SIG_JUPITER_SWAP,
  SIG_SOL_IN,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const RPC_URL = "https://rpc.test.local";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const walletA = parseWalletAddress(WATCHED_WALLET_A);
const sigSwap = parseTxSignature(SIG_JUPITER_SWAP);
const sigIn = parseTxSignature(SIG_SOL_IN);

describe("SolanaRpcClient (MSW contract tests)", () => {
  it("fetches jsonParsed v0 transaction and verifies RPC request parameters", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: capturedBody.id,
          result: {
            slot: 310000400,
            blockTime: 1760000400,
            version: 0,
            meta: {
              err: null,
              fee: 15000,
              preBalances: [5000000000, 2000000],
              postBalances: [3499985000, 2000000],
              preTokenBalances: [
                {
                  accountIndex: 1,
                  mint: USDC_MINT,
                  owner: WATCHED_WALLET_A,
                  uiTokenAmount: { amount: "10000000", decimals: 6 },
                },
              ],
              postTokenBalances: [
                {
                  accountIndex: 1,
                  mint: USDC_MINT,
                  owner: WATCHED_WALLET_A,
                  uiTokenAmount: { amount: "250000000", decimals: 6 },
                },
              ],
              innerInstructions: [
                {
                  index: 0,
                  instructions: [
                    {
                      programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
                      accounts: [WATCHED_WALLET_A],
                      data: "abc",
                    },
                  ],
                },
              ],
            },
            transaction: {
              signatures: [SIG_JUPITER_SWAP],
              message: {
                recentBlockhash: "11111111111111111111111111111111",
                accountKeys: [
                  { pubkey: WATCHED_WALLET_A, signer: true, writable: true, source: "transaction" },
                  {
                    pubkey: COUNTERPARTY_WALLET,
                    signer: false,
                    writable: true,
                    source: "lookupTable",
                  },
                ],
                instructions: [
                  {
                    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
                    accounts: [WATCHED_WALLET_A],
                    data: "xyz",
                  },
                ],
              },
            },
          },
        });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      commitment: "confirmed",
      maxRetries: 1,
      sleep: async () => {},
    });
    const tx = await client.getTransaction(sigSwap);

    expect(capturedBody?.method).toBe("getTransaction");
    expect(capturedBody?.params).toEqual([
      SIG_JUPITER_SWAP,
      {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    expect(tx).not.toBeNull();
    expect(tx?.slot).toBe(310_000_400n);
    expect(tx?.meta.fee).toBe(15_000n);
    expect(tx?.accountKeys).toEqual([WATCHED_WALLET_A, COUNTERPARTY_WALLET]);
    expect(tx?.programIds).toEqual(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]);
    expect(tx?.meta.innerInstructions).toEqual(["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"]);
  });

  it("retries HTTP 429 honoring Retry-After and eventually succeeds", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        attempts += 1;
        const body = (await request.json()) as Record<string, unknown>;
        if (attempts === 1) {
          return new HttpResponse(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "2",
            },
          });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result: [
            {
              signature: SIG_SOL_IN,
              slot: 310000100,
              blockTime: 1760000100,
              confirmationStatus: "confirmed",
              err: null,
              memo: null,
            },
          ],
        });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      commitment: "processed",
      maxRetries: 2,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const sigs = await client.getSignaturesForAddress(walletA, { until: sigSwap, limit: 10 });

    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([2_000]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.signature).toBe(sigIn);
    expect(sigs[0]?.slot).toBe(310_000_100n);
  });

  it("throws structured RpcError after exhausting retries on persistent 503", async () => {
    server.use(
      http.post(RPC_URL, () => {
        return new HttpResponse("upstream unavailable", { status: 503 });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      maxRetries: 1,
      sleep: async () => {},
    });

    const err = await client.getTransaction(sigSwap).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).retryable).toBe(true);
    expect((err as RpcError).statusCode).toBe(503);
  });

  it("returns null when getTransaction finds no transaction", async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: null });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, { maxRetries: 0 });
    expect(await client.getTransaction(sigSwap)).toBeNull();
  });

  it("retries transient null getTransaction response caused by RPC indexing lag", async () => {
    let calls = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as Record<string, unknown>;
        if (calls === 1) {
          return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: null });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            slot: 310000100,
            blockTime: 1760000100,
            version: 0,
            meta: {
              err: null,
              fee: 5000,
              preBalances: [5000000000, 1000000000],
              postBalances: [2499995000, 3500000000],
              preTokenBalances: [],
              postTokenBalances: [],
              innerInstructions: [],
            },
            transaction: {
              signatures: [SIG_SOL_IN],
              message: {
                recentBlockhash: "11111111111111111111111111111111",
                accountKeys: [
                  {
                    pubkey: COUNTERPARTY_WALLET,
                    signer: true,
                    writable: true,
                    source: "transaction",
                  },
                  {
                    pubkey: WATCHED_WALLET_A,
                    signer: false,
                    writable: true,
                    source: "transaction",
                  },
                ],
                instructions: [
                  { programId: "11111111111111111111111111111111", accounts: [], data: "11" },
                ],
              },
            },
          },
        });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      maxRetries: 2,
      nullRetryDelayMs: 1,
      sleep: async () => {},
    });
    const tx = await client.getTransaction(sigIn);
    expect(calls).toBe(2);
    expect(tx?.slot).toBe(310_000_100n);
  });

  it("retries transient network errors and fails immediately on caller abort", async () => {
    let calls = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.error();
        }
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: [] });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, { maxRetries: 1, sleep: async () => {} });
    expect(await client.getSignaturesForAddress(walletA)).toEqual([]);
    expect(calls).toBe(2);

    const aborted = new AbortController();
    aborted.abort(new Error("shutdown"));
    const err = await client.getTransaction(sigSwap, aborted.signal).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).retryable).toBe(false);
  });

  it("retries transient JSON-RPC -32005 errors, supports before pagination, and queries SPL + Token-2022 ATAs", async () => {
    const rpcBodies: Array<Record<string, unknown>> = [];
    let getTxCalls = 0;

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        rpcBodies.push(body);

        if (body.method === "getSignaturesForAddress") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: [],
          });
        }

        if (body.method === "getTokenAccountsByOwner") {
          const params = body.params as [string, { programId: string }, Record<string, unknown>];
          const program = params[1]?.programId;
          const pubkey =
            program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
              ? COUNTERPARTY_WALLET
              : WATCHED_WALLET_A;
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              context: { slot: 310000100 },
              value: [
                { pubkey, account: { data: ["", "base64"], lamports: 2039280, owner: program } },
              ],
            },
          });
        }

        if (body.method === "getTransaction") {
          getTxCalls += 1;
          if (getTxCalls === 1) {
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32005, message: "Node is behind by 150 slots" },
            });
          }
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              slot: 310000400,
              blockTime: 1760000400,
              version: 0,
              meta: {
                err: null,
                fee: 5000,
                preBalances: [5000000000],
                postBalances: [4999995000],
                preTokenBalances: [],
                postTokenBalances: [],
                innerInstructions: [
                  {
                    index: 0,
                    instructions: [
                      {
                        programId: "11111111111111111111111111111111",
                        parsed: {
                          type: "transfer",
                          info: { source: WATCHED_WALLET_A, lamports: 1000 },
                        },
                      },
                    ],
                  },
                ],
              },
              transaction: {
                signatures: [SIG_JUPITER_SWAP],
                message: {
                  recentBlockhash: "11111111111111111111111111111111",
                  accountKeys: [
                    {
                      pubkey: WATCHED_WALLET_A,
                      signer: true,
                      writable: true,
                      source: "transaction",
                    },
                  ],
                  instructions: [
                    {
                      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                      parsed: { type: "closeAccount", info: { destination: WATCHED_WALLET_A } },
                    },
                  ],
                },
              },
            },
          });
        }

        return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: null });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      maxRetries: 2,
      txCacheTtlMs: 30_000,
      sleep: async () => {},
    });

    await client.getSignaturesForAddress(walletA, { before: sigIn, until: sigSwap, limit: 50 });
    const sigCall = rpcBodies.find((b) => b.method === "getSignaturesForAddress");
    expect(sigCall?.params).toEqual([
      WATCHED_WALLET_A,
      { commitment: "confirmed", limit: 50, until: SIG_JUPITER_SWAP, before: SIG_SOL_IN },
    ]);

    const atas = await client.getTokenAccountsByOwner(walletA);
    expect(atas).toEqual([COUNTERPARTY_WALLET, WATCHED_WALLET_A]);

    // Concurrent calls coalesce into one RPC sequence (with -32005 retry) and subsequent call hits TTL cache
    const [tx1, tx2] = await Promise.all([
      client.getTransaction(sigSwap),
      client.getTransaction(sigSwap),
    ]);
    const tx3 = await client.getTransaction(sigSwap);
    expect(getTxCalls).toBe(2);
    expect(tx1?.parsedInstructions).toHaveLength(2);
    expect(tx2?.slot).toBe(310_000_400n);
    expect(tx3?.slot).toBe(310_000_400n);
  });

  it("enforces AsyncSemaphore concurrency, aborts queued waiters, evicts LRU tx cache, supports partial coalesced aborts, and fails fast on -32602", async () => {
    let activeRequests = 0;
    let maxObservedConcurrency = 0;
    let releaseFirst!: () => void;

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.method === "getSignaturesForAddress") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Invalid params" },
          });
        }

        const sigParam = (body.params as [string])[0];
        activeRequests += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests);
        try {
          if (sigParam === SIG_SOL_IN) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              slot: 310000100,
              blockTime: 1760000100,
              version: 0,
              meta: {
                err: null,
                fee: 5000,
                preBalances: [1000000],
                postBalances: [995000],
                preTokenBalances: [],
                postTokenBalances: [],
                innerInstructions: [],
              },
              transaction: {
                signatures: [sigParam],
                message: {
                  recentBlockhash: "11111111111111111111111111111111",
                  accountKeys: [
                    {
                      pubkey: WATCHED_WALLET_A,
                      signer: true,
                      writable: true,
                      source: "transaction",
                    },
                  ],
                  instructions: [],
                },
              },
            },
          });
        } finally {
          activeRequests -= 1;
        }
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, {
      commitment: "finalized",
      maxConcurrency: 1,
      txCacheMaxEntries: 1,
      txCacheTtlMs: 30_000,
      maxRetries: 2,
      sleep: async () => {},
    });

    // Non-retryable JSON-RPC -32602 fails fast without retries
    const invalidErr = await client.getSignaturesForAddress(walletA).catch((e) => e);
    expect(invalidErr).toBeInstanceOf(RpcError);
    expect((invalidErr as RpcError).retryable).toBe(false);

    // Launch slow first request + partial coalesced waiter abort + queued waiter abort
    const p1 = client.getTransaction(sigIn);
    await new Promise((r) => setTimeout(r, 10));

    const queuedCtrl = new AbortController();
    const pQueued = client.getTransaction(sigSwap, queuedCtrl.signal);
    queuedCtrl.abort(new Error("queued timeout"));
    const queuedErr = await pQueued.catch((e) => e);
    expect(queuedErr).toBeInstanceOf(RpcError);
    expect((queuedErr as RpcError).statusCode).toBe(499);

    // Partial waiter abort on sigIn must leave p1 completing normally
    const partialCtrl = new AbortController();
    const pPartial = client.getTransaction(sigIn, partialCtrl.signal);
    partialCtrl.abort();
    const partialErr = await pPartial.catch((e) => e);
    expect(partialErr).toBeInstanceOf(RpcError);

    releaseFirst();
    const res1 = await p1;
    expect(res1?.slot).toBe(310_000_100n);
    expect(maxObservedConcurrency).toBe(1);

    // Inserting sigSwap into txCacheMaxEntries=1 evicts sigIn cleanly
    const resSwap = await client.getTransaction(sigSwap);
    expect(resSwap?.signature).toBe(SIG_JUPITER_SWAP);
  });
});
