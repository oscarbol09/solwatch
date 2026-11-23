import { serve } from "@hono/node-server";
import { createApiApp } from "./api/server.js";
import { createTelegramBot } from "./bot/telegramBot.js";
import { parseEnvConfig, redactUrlSecrets } from "./config.js";
import { createLogger } from "./logger.js";
import { ConsoleNotifier } from "./notifiers/consoleNotifier.js";
import { DiscordNotifier } from "./notifiers/discordNotifier.js";
import { AlertDispatcher } from "./notifiers/dispatcher.js";
import { TelegramNotifier } from "./notifiers/telegramNotifier.js";
import type { Notifier } from "./notifiers/types.js";
import { WebhookNotifier } from "./notifiers/webhookNotifier.js";
import { MonitorService } from "./service/monitorService.js";
import { SolanaRpcClient } from "./solana/rpcClient.js";
import { KitLogsSubscriptionAdapter, SolanaWatcher } from "./solana/watcher.js";
import { SqliteStore } from "./store/sqliteStore.js";

async function main(): Promise<void> {
  const config = parseEnvConfig();
  const logger = createLogger(config.logLevel);
  const store = new SqliteStore(config.databasePath);

  const notifiers: Notifier[] = [];
  if (config.consoleAlertsEnabled) {
    notifiers.push(new ConsoleNotifier());
  }
  if (config.telegramBotToken && config.telegramAlertChatId) {
    notifiers.push(
      new TelegramNotifier({
        botToken: config.telegramBotToken,
        chatId: config.telegramAlertChatId,
      }),
    );
  }
  if (config.discordWebhookUrl) {
    notifiers.push(new DiscordNotifier({ webhookUrl: config.discordWebhookUrl }));
  }
  if (config.webhookUrl) {
    notifiers.push(
      new WebhookNotifier({
        url: config.webhookUrl,
        secret: config.webhookSecret,
      }),
    );
  }

  const dispatcher = new AlertDispatcher({
    notifiers,
    store,
    cluster: config.solanaCluster,
    logger,
  });

  const rpcClient = new SolanaRpcClient(config.solanaRpcUrl, {
    commitment: config.solanaCommitment,
  });

  const service = new MonitorService({
    store,
    rpcPort: rpcClient,
    dispatcher,
    logger,
  });

  service.ensureDefaultGlobalRule({
    minSolLamports: config.minSolAlertLamports,
    includeFailed: config.includeFailedTx,
    cooldownSeconds: config.defaultCooldownSeconds,
  });

  const watcher = new SolanaWatcher({
    subscriptionPort: new KitLogsSubscriptionAdapter(config.solanaWsUrl),
    rpcPort: rpcClient,
    store,
    commitment: config.solanaCommitment,
    logger,
    onSignature: async (wallet, signature, _source, signal) => {
      await service.processSignature(wallet, signature, signal);
    },
  });
  service.attachWatchControl(watcher);

  await watcher.start();

  const bot =
    config.telegramInteractiveEnabled && config.telegramBotToken
      ? createTelegramBot({
          botToken: config.telegramBotToken,
          allowedChatIds: config.telegramAllowedChatIds,
          service,
          store,
          cluster: config.solanaCluster,
          getStatus: () => watcher.getStatus(),
          logger,
        })
      : null;

  if (bot) {
    void bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      logger.error({ err }, "Telegram bot polling stopped unexpectedly");
    });
  }

  const app = createApiApp({
    service,
    store,
    cluster: config.solanaCluster,
    apiToken: config.apiToken,
    heliusWebhookSecret: config.heliusWebhookSecret,
    getWatcherStatus: () => watcher.getStatus(),
    channels: dispatcher.getChannels(),
    logger,
  });

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  logger.info(
    {
      cluster: config.solanaCluster,
      rpcUrl: redactUrlSecrets(config.solanaRpcUrl),
      wsUrl: redactUrlSecrets(config.solanaWsUrl),
      port: config.port,
      channels: dispatcher.getChannels(),
      interactiveBot: bot !== null,
    },
    "solwatch started",
  );

  let shuttingDown = false;
  const shutdown = async (signalName: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal: signalName }, "Shutting down solwatch cleanly");

    await Promise.allSettled([
      watcher.stop(),
      bot ? bot.stop() : Promise.resolve(),
      new Promise<void>((resolve) => {
        if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
        server.close(() => resolve());
      }),
    ]);

    store.close();
    process.exit(exitCode);
  };

  server.on("error", (err: unknown) => {
    logger.error({ err, host: config.host, port: config.port }, "HTTP server error");
    void shutdown("SERVER_ERROR", 1);
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal startup failure: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
