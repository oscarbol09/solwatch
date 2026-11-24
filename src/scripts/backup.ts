import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "../store/sqliteStore.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function generateDefaultBackupPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `./data/backups/solwatch-backup-${ts}.db`;
}

export function performBackup(
  dbPath: string,
  targetPath: string,
): { readonly targetPath: string; readonly sizeBytes: number; readonly durationMs: number } {
  const resolvedDbPath = resolve(dbPath);
  if (!existsSync(resolvedDbPath)) {
    const initStore = new SqliteStore(resolvedDbPath);
    initStore.close();
  }

  const startMs = Date.now();
  const store = new SqliteStore(resolvedDbPath);
  try {
    store.backup(targetPath);
    const durationMs = Date.now() - startMs;
    const resolvedTarget = resolve(targetPath);
    const stats = statSync(resolvedTarget);
    return {
      targetPath: resolvedTarget,
      sizeBytes: stats.size,
      durationMs,
    };
  } finally {
    store.close();
  }
}

export function runCli(argv: readonly string[] = process.argv, envDb?: string): boolean {
  const sourceDb = envDb ?? process.env.DATABASE_PATH ?? "./data/solwatch.db";
  const targetPath = argv[2] || generateDefaultBackupPath();

  process.stdout.write(`Creating online SQLite WAL backup from "${sourceDb}"...\n`);
  try {
    const result = performBackup(sourceDb, targetPath);
    process.stdout.write(
      `Backup completed successfully in ${result.durationMs}ms\n` +
        `Destination: ${result.targetPath} (${formatBytes(result.sizeBytes)})\n`,
    );
    return true;
  } catch (err) {
    process.stderr.write(`Backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

if (process.argv[1]?.endsWith("backup.ts") || process.argv[1]?.endsWith("backup.js")) {
  const success = runCli();
  if (!success) {
    process.exit(1);
  }
}
