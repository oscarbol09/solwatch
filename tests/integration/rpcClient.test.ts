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

  it("retries transient network errors and fails immediately on caller abort", async () => {
    let calls = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.error();
        }
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: null });
      }),
    );

    const client = new SolanaRpcClient(RPC_URL, { maxRetries: 1, sleep: async () => {} });
    expect(await client.getTransaction(sigSwap)).toBeNull();
    expect(calls).toBe(2);

    const aborted = new AbortController();
    aborted.abort();
    const err = await client.getTransaction(sigSwap, aborted.signal).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).retryable).toBe(false);
  });
});
