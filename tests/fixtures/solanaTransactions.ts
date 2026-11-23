import type { SolanaTransactionInput } from "../../src/domain/classifier.js";
import { BONK_MINT, USDC_MINT, WSOL_MINT } from "../../src/domain/tokens.js";

export const WATCHED_WALLET_A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const COUNTERPARTY_WALLET = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRJe";
export const CUSTOM_UNKNOWN_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

export const SIG_SOL_IN =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
export const SIG_SOL_OUT =
  "LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ";
export const SIG_SPL_USDC =
  "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM9d8fP3k2L9m1N8p4Q7r5S2t6U9v3W1x4Y7z8A2b5C9d1E";
export const SIG_TOKEN_2022 =
  "gaiC7Rnf9J6tV3SGwJyzvMDdz9RMmreSWZDyDK682MUB3bdBc5gVodbQCgxJUR7CVEkqMnd9xjWo8q8YP1RYyub";
export const SIG_JUPITER_SWAP =
  "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
export const SIG_RAYDIUM_SWAP =
  "22NZnfeBVDSeqE4euuTyVt2KxUidYAHUAGLLTKU8gY2hm4twGud2FCwtboXvxD8AJEMdkYBSESbmhCkCK51dpyMt";
export const SIG_FAILED_TX =
  "2NARPDraKHbCmy5sYscxzqhSGyHqiYiHt27SwRdBF3hwM6CFNDAMzcGBoQNubwqDPyUWfiaFJvU2bGfG5m1r6xpB";
export const SIG_PROGRAM_ONLY =
  "2hxGyn4y9Mjkii76BqmxVoNYbTs3tw97bmtZRXnDoZPAw7VZTWhhk1aV11DtFgYGVibPaty4PQLHVLaKrT24NxGU";

export function makeIncomingSolTx(): SolanaTransactionInput {
  return {
    signature: SIG_SOL_IN,
    slot: 310_000_100n,
    blockTime: 1_760_000_100,
    meta: {
      err: null,
      fee: 5_000n,
      preBalances: [5_000_000_000n, 1_000_000_000n, 1n],
      postBalances: [2_499_995_000n, 3_500_000_000n, 1n],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
    accountKeys: [COUNTERPARTY_WALLET, WATCHED_WALLET_A, "11111111111111111111111111111111"],
    programIds: ["11111111111111111111111111111111"],
  };
}

export function makeOutgoingSolTx(): SolanaTransactionInput {
  return {
    signature: SIG_SOL_OUT,
    slot: 310_000_200n,
    blockTime: 1_760_000_200,
    meta: {
      err: null,
      fee: 5_000n,
      preBalances: [4_000_000_000n, 500_000_000n, 1n],
      postBalances: [2_499_995_000n, 2_000_000_000n, 1n],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
    accountKeys: [WATCHED_WALLET_A, COUNTERPARTY_WALLET, "11111111111111111111111111111111"],
    programIds: ["11111111111111111111111111111111"],
  };
}

export function makeSplUsdcTransferTx(): SolanaTransactionInput {
  return {
    signature: SIG_SPL_USDC,
    slot: 310_000_300n,
    blockTime: 1_760_000_300,
    meta: {
      err: null,
      fee: 5_000n,
      // Fee payer spent only 5000 lamports in gas -> net SOL transfer delta is 0n
      preBalances: [2_000_000_000n, 1_000_000n, 1_000_000n],
      postBalances: [1_999_995_000n, 1_000_000n, 1_000_000n],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: COUNTERPARTY_WALLET,
          uiTokenAmount: { amount: "5000000000", decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: USDC_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "100000000", decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: COUNTERPARTY_WALLET,
          uiTokenAmount: { amount: "3750000000", decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: USDC_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "1350000000", decimals: 6 },
        },
      ],
      innerInstructions: [],
    },
    accountKeys: [
      COUNTERPARTY_WALLET,
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV",
    ],
    programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  };
}

export function makeToken2022DustTx(): SolanaTransactionInput {
  return {
    signature: SIG_TOKEN_2022,
    slot: 310_000_350n,
    blockTime: 1_760_000_350,
    meta: {
      err: null,
      fee: 5_000n,
      preBalances: [1_000_000_000n, 2_000_000n],
      postBalances: [999_995_000n, 2_000_000n],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: CUSTOM_UNKNOWN_MINT,
          owner: WATCHED_WALLET_A,
          programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          uiTokenAmount: { amount: "1000000", decimals: 9 },
        },
      ],
      innerInstructions: [],
    },
    accountKeys: [COUNTERPARTY_WALLET, "5xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsW"],
    programIds: ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
  };
}

export function makeJupiterSwapTx(): SolanaTransactionInput {
  return {
    signature: SIG_JUPITER_SWAP,
    slot: 310_000_400n,
    blockTime: 1_760_000_400,
    meta: {
      err: null,
      fee: 15_000n,
      // Wallet spent 1.5 SOL (plus 15_000 lamports fee) and received 240 USDC
      preBalances: [5_000_000_000n, 2_000_000n],
      postBalances: [3_499_985_000n, 2_000_000n],
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
      innerInstructions: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
    },
    accountKeys: [WATCHED_WALLET_A, "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV"],
    programIds: [
      "ComputeBudget111111111111111111111111111111",
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ],
  };
}

export function makeRaydiumTokenToTokenSwapTx(): SolanaTransactionInput {
  return {
    signature: SIG_RAYDIUM_SWAP,
    slot: 310_000_450n,
    blockTime: 1_760_000_450,
    meta: {
      err: null,
      fee: 10_000n,
      preBalances: [2_000_000_000n, 2_000_000n, 2_000_000n],
      postBalances: [1_999_990_000n, 2_000_000n, 2_000_000n],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "500000000", decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: BONK_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "0", decimals: 5 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "400000000", decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: BONK_MINT,
          owner: WATCHED_WALLET_A,
          uiTokenAmount: { amount: "45000000000", decimals: 5 },
        },
      ],
      innerInstructions: [],
    },
    accountKeys: [
      WATCHED_WALLET_A,
      "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV",
      "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsX",
    ],
    programIds: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
  };
}

export function makeFailedTx(): SolanaTransactionInput {
  return {
    signature: SIG_FAILED_TX,
    slot: 310_000_500n,
    blockTime: 1_760_000_500,
    meta: {
      err: { InstructionError: [0, { Custom: 6001 }] },
      fee: 5_000n,
      preBalances: [2_000_000_000n],
      postBalances: [1_999_995_000n],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
    accountKeys: [WATCHED_WALLET_A],
    programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  };
}

export function makeProgramOnlyTx(): SolanaTransactionInput {
  return {
    signature: SIG_PROGRAM_ONLY,
    slot: 310_000_600n,
    blockTime: 1_760_000_600,
    meta: {
      err: null,
      fee: 5_000n,
      preBalances: [2_000_000_000n],
      postBalances: [1_999_995_000n],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
    accountKeys: [WATCHED_WALLET_A],
    programIds: [
      "ComputeBudget111111111111111111111111111111",
      "Stake11111111111111111111111111111111111111",
    ],
  };
}

export const HELIUS_WEBHOOK_FIXTURE = [
  {
    signature: SIG_JUPITER_SWAP,
    slot: 310_000_400,
    timestamp: 1_760_000_400,
    fee: 15_000,
    feePayer: WATCHED_WALLET_A,
    type: "SWAP",
    source: "JUPITER",
    description: "Swapped 1.5 SOL for 240 USDC on Jupiter",
    transactionError: null,
    nativeTransfers: [
      {
        fromUserAccount: WATCHED_WALLET_A,
        toUserAccount: COUNTERPARTY_WALLET,
        amount: 1_500_000_000,
      },
    ],
    tokenTransfers: [
      {
        fromUserAccount: COUNTERPARTY_WALLET,
        toUserAccount: WATCHED_WALLET_A,
        mint: USDC_MINT,
        tokenAmount: 240,
      },
    ],
    events: {
      swap: {
        nativeInput: {
          account: WATCHED_WALLET_A,
          amount: "1500000000",
        },
        tokenOutputs: [
          {
            userAccount: WATCHED_WALLET_A,
            mint: USDC_MINT,
            rawTokenAmount: { tokenAmount: "240000000", decimals: 6 },
          },
        ],
      },
    },
  },
  {
    signature: SIG_SOL_IN,
    slot: 310_000_100,
    timestamp: 1_760_000_100,
    fee: 5_000,
    feePayer: COUNTERPARTY_WALLET,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    transactionError: null,
    nativeTransfers: [
      {
        fromUserAccount: COUNTERPARTY_WALLET,
        toUserAccount: WATCHED_WALLET_A,
        amount: 2_500_000_000,
      },
    ],
    tokenTransfers: [],
  },
  {
    signature: SIG_SPL_USDC,
    slot: 310_000_300,
    timestamp: 1_760_000_300,
    fee: 5_000,
    feePayer: COUNTERPARTY_WALLET,
    type: "TRANSFER",
    source: "SOLANA_PROGRAM_LIBRARY",
    transactionError: null,
    nativeTransfers: [],
    tokenTransfers: [
      {
        fromUserAccount: COUNTERPARTY_WALLET,
        toUserAccount: WATCHED_WALLET_A,
        mint: USDC_MINT,
        tokenAmount: 1250.5,
      },
    ],
  },
];

export { WSOL_MINT };
