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

async function flushLogger(logger: ReturnType<typeof createLogger>): Promise<void> {
  await new Promise<void>((resolve) => {
    logger.flush(() => resolve());
  });
}

async function main(): Promise<void> {
  const config = parseEnvConfig();
  const logger = createLogger(config.logLevel);
  const store = new SqliteStore(config.databasePath);
  const shutdownController = new AbortController();

  let watcher: SolanaWatcher | null = null;
  let bot: ReturnType<typeof createTelegramBot> | null = null;
  let service: MonitorService | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let shuttingDown = false;

  const shutdown = async (signalName: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal: signalName }, "Shutting down solwatch cleanly");
    shutdownController.abort();

    const watchdog = setTimeout(() => {
      logger.warn("Shutdown deadline reached; forcing exit");
      store.close();
      process.exit(exitCode || 1);
    }, 8_000);
    watchdog.unref();

    service?.stopBackgroundWorkers();

    const activeServer = server;
    await Promise.allSettled([
      watcher ? watcher.stop() : Promise.resolve(),
      service ? service.drain(3_000) : Promise.resolve(),
      bot ? bot.stop() : Promise.resolve(),
      activeServer
        ? new Promise<void>((resolve) => {
            if (
              "closeIdleConnections" in activeServer &&
              typeof activeServer.closeIdleConnections === "function"
            ) {
              activeServer.closeIdleConnections();
            }
            const forceClose = setTimeout(() => {
              if (
                "closeAllConnections" in activeServer &&
                typeof activeServer.closeAllConnections === "function"
              ) {
                activeServer.closeAllConnections();
              }
              resolve();
            }, 3_000);
            forceClose.unref();
            activeServer.close(() => {
              clearTimeout(forceClose);
              resolve();
            });
          })
        : Promise.resolve(),
    ]);

    clearTimeout(watchdog);
    store.close();
    await flushLogger(logger);
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
    void shutdown("UNHANDLED_REJECTION", 1);
  });
  process.once("uncaughtException", (err: unknown) => {
    logger.error({ err }, "Uncaught exception");
    void shutdown("UNCAUGHT_EXCEPTION", 1);
  });

  try {
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

    service = new MonitorService({
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

    const activeService = service;
    watcher = new SolanaWatcher({
      subscriptionPort: new KitLogsSubscriptionAdapter(config.solanaWsUrl),
      rpcPort: rpcClient,
      store,
      commitment: config.solanaCommitment,
      logger,
      onSignature: async (wallet, signature, _source, signal, meta) => {
        await activeService.processSignature(wallet, signature, signal, meta);
      },
    });
    service.attachWatchControl(watcher);

    await watcher.start();
    service.startBackgroundWorkers(shutdownController.signal);

    const activeWatcher = watcher;
    bot =
      config.telegramInteractiveEnabled && config.telegramBotToken
        ? createTelegramBot({
            botToken: config.telegramBotToken,
            allowedChatIds: config.telegramAllowedChatIds,
            service,
            store,
            cluster: config.solanaCluster,
            getStatus: () => activeWatcher.getStatus(),
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
      getWatcherStatus: () => activeWatcher.getStatus(),
      channels: dispatcher.getChannels(),
      logger,
      shutdownSignal: shutdownController.signal,
    });

    server = serve(
      {
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
        serverOptions: {
          headersTimeout: 10_000,
          requestTimeout: 30_000,
          keepAliveTimeout: 5_000,
        },
      },
      (info) => {
        logger.info(
          {
            cluster: config.solanaCluster,
            rpcUrl: redactUrlSecrets(config.solanaRpcUrl),
            wsUrl: redactUrlSecrets(config.solanaWsUrl),
            host: config.host,
            port: info.port,
            channels: dispatcher.getChannels(),
            interactiveBot: bot !== null,
          },
          "solwatch started",
        );
      },
    );

    server.on("error", (err: unknown) => {
      logger.error({ err, host: config.host, port: config.port }, "HTTP server error");
      void shutdown("SERVER_ERROR", 1);
    });
  } catch (err) {
    logger.error({ err }, "Fatal startup error; releasing resources");
    await shutdown("STARTUP_ERROR", 1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal startup failure: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
