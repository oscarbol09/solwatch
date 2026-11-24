import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWalletAddress } from "../../src/domain/types.js";
import {
  formatBytes,
  generateDefaultBackupPath,
  performBackup,
  runCli,
} from "../../src/scripts/backup.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";

describe("SQLite Online Backup Utility", () => {
  const testDbPath = resolve("./tests/test_source.db");
  const testBackupPath = resolve("./tests/test_dest.db");
  const testWallet = parseWalletAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

  afterEach(() => {
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testBackupPath)) {
      unlinkSync(testBackupPath);
    }
  });

  describe("formatBytes", () => {
    it("formats byte values cleanly", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(2048)).toBe("2.0 KiB");
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MiB");
    });
  });

  describe("generateDefaultBackupPath", () => {
    it("generates a timestamped db path", () => {
      const path = generateDefaultBackupPath();
      expect(path).toMatch(/^\.\/data\/backups\/solwatch-backup-.*\.db$/);
    });
  });

  describe("performBackup", () => {
    it("auto-initializes schema and backs up if source database file did not exist yet", () => {
      const freshDb = resolve("./tests/test_fresh_init.db");
      try {
        const result = performBackup(freshDb, testBackupPath);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(existsSync(testBackupPath)).toBe(true);
      } finally {
        if (existsSync(freshDb)) unlinkSync(freshDb);
      }
    });

    it("creates an atomic single-file SQLite backup", () => {
      const store = new SqliteStore(testDbPath);
      store.createWallet(testWallet, "Primary Cold Wallet");
      store.close();

      const result = performBackup(testDbPath, testBackupPath);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(existsSync(testBackupPath)).toBe(true);

      // Verify the backup can be read independently
      const backupStore = new SqliteStore(testBackupPath);
      expect(backupStore.countWallets()).toBe(1);
      const wallet = backupStore.getWallet(testWallet);
      expect(wallet?.label).toBe("Primary Cold Wallet");
      backupStore.close();
    });

    it("runs via runCli helper with success and failure branches", () => {
      // 1. Failure when target path is an existing directory
      const fail = runCli(["node", "backup.ts", "."], testDbPath);
      expect(fail).toBe(false);

      // 2. Success when source db exists
      const store = new SqliteStore(testDbPath);
      store.createWallet(testWallet, "Cold Storage");
      store.close();

      const ok = runCli(["node", "backup.ts", testBackupPath], testDbPath);
      expect(ok).toBe(true);
      expect(existsSync(testBackupPath)).toBe(true);
    });
  });
});
