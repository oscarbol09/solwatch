import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getBase58Decoder } from "@solana/codecs-strings";
import { afterEach, describe, expect, it } from "vitest";
import { parseTxSignature, parseWalletAddress, type TxSignature } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import { MonitorService } from "../../src/service/monitorService.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { COUNTERPARTY_WALLET, WATCHED_WALLET_A } from "../fixtures/solanaTransactions.js";

const base58Decoder = getBase58Decoder();

function makeSignature(index: number): TxSignature {
  const bytes = new Uint8Array(64);
  bytes[0] = (index >> 24) & 0xff || 1;
  bytes[1] = (index >> 16) & 0xff;
  bytes[2] = (index >> 8) & 0xff;
  bytes[3] = index & 0xff;
  return parseTxSignature(base58Decoder.decode(bytes));
}

describe("Concurrency and Transactional Integrity", () => {
  let dbFilesToClean: string[] = [];
  let openStore: SqliteStore | null = null;

  afterEach(() => {
    if (openStore) {
      try {
        openStore.close();
      } catch {
        // ignore
      }
      openStore = null;
    }
    for (const f of dbFilesToClean) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {
          // ignore lock on Windows
        }
      }
    }
    dbFilesToClean = [];
  });

  it("handles concurrent transaction processing and wallet removal without race crashes", async () => {
    const randomSuffix = Math.random().toString(36).slice(2);
    const dbFile = resolve(`./tests/test_concurrency_${randomSuffix}.db`);
    dbFilesToClean.push(dbFile);

    const store = new SqliteStore(dbFile);
    openStore = store;
    const wallet = parseWalletAddress(WATCHED_WALLET_A);
    store.createWallet(wallet, "Concurrent Target");

    const service = new MonitorService({
      store,
      rpcPort: {
        getTransaction: async () => null,
        getSignaturesForAddress: async () => [],
      },
      dispatcher: new AlertDispatcher({
        notifiers: [],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
    });

    // Concurrently trigger 25 signature process attempts while removing the wallet midway
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i += 1) {
      const sig = makeSignature(i + 1);
      tasks.push(
        service.processSignature(wallet, sig, undefined, {
          slot: BigInt(300_000_000 + i),
          err: null,
          advanceRpcCursor: true,
        }),
      );
      if (i === 12) {
        tasks.push(
          Promise.resolve().then(() => {
            store.removeWallet(wallet);
          }),
        );
      }
    }

    const results = await Promise.allSettled(tasks);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Verify database remains valid and non-corrupt
    expect(store.ping()).toBe(true);
    store.close();
    openStore = null;
  });

  it("supports concurrent outbox item insertion, claiming, and resolution", async () => {
    const store = new SqliteStore(":memory:");
    openStore = store;
    const wallet = parseWalletAddress(WATCHED_WALLET_A);
    store.createWallet(wallet, "Outbox Test");

    const parallelInserts = Array.from({ length: 30 }, (_, i) => {
      const sig = makeSignature(100 + i);
      return store.enqueueOutboxItems([
        {
          deliveryId: `deliv-${i}`,
          walletAddress: wallet,
          walletLabel: "Outbox Test",
          signature: sig,
          event: {
            kind: "sol_transfer",
            signature: sig,
            slot: BigInt(300000000 + i),
            timestampSec: 1760000000,
            wallet,
            direction: "in",
            counterparty: COUNTERPARTY_WALLET,
            lamports: 1000000000n,
            feeLamports: 5000n,
            success: true,
          },
          channel: "webhook",
          nextRetryAtMs: Date.now() - 1000,
          lastError: null,
        },
      ]);
    });

    await Promise.all(parallelInserts);
    expect(store.countPendingOutbox()).toBe(30);

    // Concurrently claim and update outbox status
    const due = store.listDueOutboxItems(Date.now(), 50);
    expect(due.length).toBe(30);

    const parallelUpdates = due.map((item, idx) => {
      return Promise.resolve().then(() => {
        if (idx % 2 === 0) {
          store.markOutboxSent(item.id);
        } else {
          store.rescheduleOutboxItem(
            item.id,
            item.maxAttempts,
            item.maxAttempts,
            Date.now() + 10_000,
            "failed delivery",
          );
        }
      });
    });

    await Promise.all(parallelUpdates);
    expect(store.countPendingOutbox()).toBe(0);
    store.close();
    openStore = null;
  });

  it("guarantees monotonic keyset pagination under parallel inserts", async () => {
    const store = new SqliteStore(":memory:");
    openStore = store;
    const wallet = parseWalletAddress(WATCHED_WALLET_A);
    store.createWallet(wallet, "Pagination Test");

    // Parallel insert of 40 deliveries
    const insertTasks = Array.from({ length: 40 }, (_, i) => {
      return Promise.resolve().then(() => {
        store.recordDeliveriesBatch([
          {
            walletAddress: wallet,
            signature: makeSignature(500 + i),
            eventKind: "sol_transfer",
            summary: `Transfer ${i}`,
            channel: "telegram",
            status: "sent",
          },
        ]);
      });
    });

    await Promise.all(insertTasks);

    // Keyset pagination in pages of 10 using listRecentAlerts
    const collectedIds: number[] = [];
    let cursor: number | undefined;

    for (let page = 0; page < 4; page += 1) {
      const deliveries = store.listRecentAlerts(10, wallet, { beforeId: cursor });
      for (const item of deliveries) {
        collectedIds.push(item.id);
      }
      cursor = collectedIds[collectedIds.length - 1];
    }

    expect(collectedIds.length).toBe(40);
    // Verify strict descending order
    for (let i = 1; i < collectedIds.length; i += 1) {
      const prev = collectedIds[i - 1];
      const curr = collectedIds[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev).toBeGreaterThan(curr);
      }
    }

    // Verify all IDs are unique (zero duplicates)
    expect(new Set(collectedIds).size).toBe(40);
    store.close();
    openStore = null;
  });
});
