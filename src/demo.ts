import { parseEnvConfig, redactUrlSecrets } from "./config.js";
import type { SolanaTransactionInput } from "./domain/classifier.js";
import { BONK_MINT, LAMPORTS_PER_SOL, USDC_MINT } from "./domain/tokens.js";
import {
  parseMintAddress,
  parseRuleId,
  parseTxSignature,
  parseWalletAddress,
  type TxSignature,
} from "./domain/types.js";
import { createLogger } from "./logger.js";
import { ConsoleNotifier } from "./notifiers/consoleNotifier.js";
import { AlertDispatcher } from "./notifiers/dispatcher.js";
import { MonitorService } from "./service/monitorService.js";
import { SolanaRpcClient, type SolanaRpcPort } from "./solana/rpcClient.js";
import { KitLogsSubscriptionAdapter, SolanaWatcher } from "./solana/watcher.js";
import { SqliteStore } from "./store/sqliteStore.js";

const TREASURY_WALLET = parseWalletAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const COUNTERPARTY = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRJe";
const SPAM_MINT = parseMintAddress("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");

const SIG_SOL_IN = parseTxSignature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
);
const SIG_USDC_IN = parseTxSignature(
  "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM9d8fP3k2L9m1N8p4Q7r5S2t6U9v3W1x4Y7z8A2b5C9d1E",
);
const SIG_JUP_SWAP = parseTxSignature(
  "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7",
);
const SIG_SPAM_DUST = parseTxSignature(
  "gaiC7Rnf9J6tV3SGwJyzvMDdz9RMmreSWZDyDK682MUB3bdBc5gVodbQCgxJUR7CVEkqMnd9xjWo8q8YP1RYyub",
);
const SIG_FAILED = parseTxSignature(
  "2NARPDraKHbCmy5sYscxzqhSGyHqiYiHt27SwRdBF3hwM6CFNDAMzcGBoQNubwqDPyUWfiaFJvU2bGfG5m1r6xpB",
);

function buildDemoFixtures(): Map<TxSignature, SolanaTransactionInput> {
  return new Map<TxSignature, SolanaTransactionInput>([
    [
      SIG_SOL_IN,
      {
        signature: SIG_SOL_IN,
        slot: 312_500_110n,
        blockTime: 1_760_000_100,
        meta: {
          err: null,
          fee: 5_000n,
          preBalances: [5_000_000_000n, 1_000_000_000n],
          postBalances: [2_499_995_000n, 3_500_000_000n],
        },
        accountKeys: [COUNTERPARTY, TREASURY_WALLET],
        programIds: ["11111111111111111111111111111111"],
      },
    ],
    [
      SIG_USDC_IN,
      {
        signature: SIG_USDC_IN,
        slot: 312_500_220n,
        blockTime: 1_760_000_200,
        meta: {
          err: null,
          fee: 5_000n,
          preBalances: [2_000_000_000n, 2_000_000n, 2_000_000n],
          postBalances: [1_999_995_000n, 2_000_000n, 2_000_000n],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: COUNTERPARTY,
              uiTokenAmount: { amount: "5000000000", decimals: 6 },
            },
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: TREASURY_WALLET,
              uiTokenAmount: { amount: "100000000", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: COUNTERPARTY,
              uiTokenAmount: { amount: "3750000000", decimals: 6 },
            },
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: TREASURY_WALLET,
              uiTokenAmount: { amount: "1350000000", decimals: 6 },
            },
          ],
        },
        accountKeys: [
          COUNTERPARTY,
          "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV",
        ],
        programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      },
    ],
    [
      SIG_JUP_SWAP,
      {
        signature: SIG_JUP_SWAP,
        slot: 312_500_330n,
        blockTime: 1_760_000_300,
        meta: {
          err: null,
          fee: 15_000n,
          preBalances: [5_000_000_000n, 2_000_000n],
          postBalances: [3_499_985_000n, 2_000_000n],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: BONK_MINT,
              owner: TREASURY_WALLET,
              uiTokenAmount: { amount: "0", decimals: 5 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: BONK_MINT,
              owner: TREASURY_WALLET,
              uiTokenAmount: { amount: "45000000000", decimals: 5 },
            },
          ],
          innerInstructions: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
        },
        accountKeys: [TREASURY_WALLET, "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV"],
        programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      },
    ],
    [
      SIG_SPAM_DUST,
      {
        signature: SIG_SPAM_DUST,
        slot: 312_500_440n,
        blockTime: 1_760_000_400,
        meta: {
          err: null,
          fee: 5_000n,
          preBalances: [1_000_000_000n, 2_000_000n],
          postBalances: [999_995_000n, 2_000_000n],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: SPAM_MINT,
              owner: TREASURY_WALLET,
              uiTokenAmount: { amount: "1000000", decimals: 9 },
            },
          ],
        },
        accountKeys: [COUNTERPARTY, "5xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsW"],
        programIds: ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
      },
    ],
    [
      SIG_FAILED,
      {
        signature: SIG_FAILED,
        slot: 312_500_550n,
        blockTime: 1_760_000_500,
        meta: {
          err: { InstructionError: [0, { Custom: 6001 }] },
          fee: 5_000n,
          preBalances: [3_000_000_000n],
          postBalances: [2_999_995_000n],
        },
        accountKeys: [TREASURY_WALLET],
        programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      },
    ],
  ]);
}

function writeLine(line: string = ""): void {
  process.stdout.write(`${line}\n`);
}

async function runReplayDemo(): Promise<void> {
  const store = new SqliteStore(":memory:");
  const logger = createLogger("silent");
  const fixtures = buildDemoFixtures();

  const fixtureRpc: SolanaRpcPort = {
    async getTransaction(sig) {
      return fixtures.get(sig) ?? null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  };

  const dispatcher = new AlertDispatcher({
    notifiers: [new ConsoleNotifier()],
    store,
    cluster: "mainnet-beta",
    logger,
  });

  const service = new MonitorService({
    store,
    rpcPort: fixtureRpc,
    dispatcher,
    logger,
  });

  await service.addWallet(TREASURY_WALLET, "Main Treasury");
  store.upsertRule({
    id: parseRuleId("demo-policy"),
    walletAddress: null,
    minSolLamports: LAMPORTS_PER_SOL / 10n,
    eventTypes: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"],
    mintAllowlist: [],
    mintDenylist: [SPAM_MINT],
    includeFailed: false,
    cooldownSeconds: 0,
    enabled: true,
  });

  writeLine("=== solwatch offline replay demo ===");
  writeLine("Watching: Main Treasury (9xQe...usVFin)");
  writeLine("Policy: min 0.1 SOL | ignore failed txs | denylist spam mint\n");

  const sequence: ReadonlyArray<{ label: string; sig: TxSignature }> = [
    { label: "1. Native SOL inflow (2.5 SOL)", sig: SIG_SOL_IN },
    { label: "2. Duplicate delivery of same signature (dedupe check)", sig: SIG_SOL_IN },
    { label: "3. SPL USDC inflow (+1250 USDC)", sig: SIG_USDC_IN },
    { label: "4. Jupiter v6 swap (1.5 SOL -> 450,000 BONK)", sig: SIG_JUP_SWAP },
    { label: "5. Token-2022 spam dust mint (filtered by denylist)", sig: SIG_SPAM_DUST },
    { label: "6. Failed Jupiter swap tx (suppressed by rule)", sig: SIG_FAILED },
  ];

  for (const step of sequence) {
    const outcome = await service.processSignature(TREASURY_WALLET, step.sig);
    if (outcome.status === "deduped") {
      writeLine(`[DEDUPED] ${step.label}\n`);
    } else if (outcome.status === "filtered") {
      writeLine(`[FILTERED:${outcome.reason}] ${step.label}\n`);
    }
  }

  const metrics = service.getMetrics();
  writeLine("=== Summary Metrics ===");
  writeLine(
    `Processed: ${metrics.processedTotal} | Dispatched: ${metrics.dispatchedTotal} | Deduped: ${metrics.dedupedTotal} | Filtered: ${metrics.filteredTotal}`,
  );
  store.close();
}

async function runLiveDemo(rawWallet: string): Promise<void> {
  const wallet = parseWalletAddress(rawWallet);
  const config = parseEnvConfig();
  const logger = createLogger("info");
  const store = new SqliteStore(":memory:");

  const dispatcher = new AlertDispatcher({
    notifiers: [new ConsoleNotifier()],
    store,
    cluster: config.solanaCluster,
    logger,
  });
  const rpcPort = new SolanaRpcClient(config.solanaRpcUrl, {
    commitment: config.solanaCommitment,
  });
  const service = new MonitorService({ store, rpcPort, dispatcher, logger });
  service.ensureDefaultGlobalRule({
    minSolLamports: config.minSolAlertLamports,
    includeFailed: config.includeFailedTx,
    cooldownSeconds: config.defaultCooldownSeconds,
  });
  await service.addWallet(wallet, "Live Target");

  const watcher = new SolanaWatcher({
    subscriptionPort: new KitLogsSubscriptionAdapter(config.solanaWsUrl),
    rpcPort,
    store,
    commitment: config.solanaCommitment,
    logger,
    onSignature: async (addr, sig) => {
      await service.processSignature(addr, sig);
    },
  });

  writeLine(
    `Watching live wallet ${wallet} on ${config.solanaCluster} (${redactUrlSecrets(config.solanaWsUrl)}). Press Ctrl+C to stop.`,
  );
  await watcher.start();

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await watcher.stop();
  store.close();
}

const args = process.argv.slice(2);
const liveIdx = args.indexOf("--live");
if (liveIdx >= 0) {
  const targetWallet = args[liveIdx + 1];
  if (!targetWallet) {
    process.stderr.write("Usage: npm run demo -- --live <solana_wallet_address>\n");
    process.exit(1);
  }
  runLiveDemo(targetWallet).catch((err: unknown) => {
    process.stderr.write(`Live demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  runReplayDemo().catch((err: unknown) => {
    process.stderr.write(`Demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
