import type { Update } from "grammy/types";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTelegramBot } from "../../src/bot/telegramBot.js";
import { parseTxSignature, parseWalletAddress } from "../../src/domain/types.js";
import { createLogger } from "../../src/logger.js";
import { AlertDispatcher } from "../../src/notifiers/dispatcher.js";
import { MonitorService } from "../../src/service/monitorService.js";
import type { SolanaRpcPort } from "../../src/solana/rpcClient.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import {
  COUNTERPARTY_WALLET,
  SIG_SOL_IN,
  WATCHED_WALLET_A,
} from "../fixtures/solanaTransactions.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeTextUpdate(
  updateId: number,
  chatId: number,
  text: string,
  options: {
    userId?: number;
    isBot?: boolean;
    chatType?: "private" | "supergroup";
  } = {},
): Update {
  const commandToken = text.split(" ")[0] ?? text;
  const userId = options.userId ?? chatId;
  const chatType = options.chatType ?? "private";
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_760_000_000,
      chat:
        chatType === "supergroup"
          ? { id: chatId, type: "supergroup", title: "Solwatch Group" }
          : { id: chatId, type: "private", first_name: "Tester" },
      from: { id: userId, is_bot: options.isBot ?? false, first_name: "Tester" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ offset: 0, length: commandToken.length, type: "bot_command" }] }
        : {}),
    },
  };
}

describe("Telegram interactive bot (grammY + MSW)", () => {
  it("handles commands, drops unauthorized/bot updates silently, and enforces group admin ACLs + bounds", async () => {
    const replies: string[] = [];
    server.use(
      http.post("https://api.telegram.org/botBOT_TOKEN/sendMessage", async ({ request }) => {
        const body = (await request.json()) as { text?: string };
        if (body.text) replies.push(body.text);
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: replies.length,
            date: 1_760_000_000,
            chat: { id: 1001, type: "private" },
            text: body.text ?? "",
          },
        });
      }),
    );

    const store = new SqliteStore(":memory:");
    const rpcPort: SolanaRpcPort = {
      async getTransaction() {
        return null;
      },
      async getSignaturesForAddress() {
        return [];
      },
    };
    const service = new MonitorService({
      store,
      rpcPort,
      dispatcher: new AlertDispatcher({
        notifiers: [],
        store,
        cluster: "mainnet-beta",
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
      maxWatchedWallets: 2,
    });

    const bot = createTelegramBot({
      botToken: "BOT_TOKEN",
      allowedChatIds: ["1001"],
      service,
      store,
      cluster: "mainnet-beta",
      getStatus: () => ({
        running: true,
        watchedCount: store.listWallets(true).length,
        reconnectsTotal: 0,
      }),
      logger: createLogger("silent"),
      botInfo: {
        id: 999,
        is_bot: true,
        first_name: "solwatch",
        username: "solwatch_test_bot",
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        supports_guest_queries: false,
        needs_inline_query_location: false,
        has_topic_sidebar: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });

    // Unauthorized chat and bot senders must be dropped silently (0 outbound replies)
    await bot.handleUpdate(makeTextUpdate(1, 9999, "/status"));
    await bot.handleUpdate(makeTextUpdate(10, 1001, "/status", { isBot: true }));
    expect(replies).toHaveLength(0);

    await bot.handleUpdate(makeTextUpdate(2, 1001, "/start"));
    expect(replies.at(-1)).toContain("/watch");

    await bot.handleUpdate(makeTextUpdate(20, 1001, "/help"));
    expect(replies.at(-1)).toContain("solwatch commands");

    await bot.handleUpdate(makeTextUpdate(21, 1001, "/list"));
    expect(replies.at(-1)).toContain("No wallets tracked yet");

    await bot.handleUpdate(makeTextUpdate(22, 1001, "/watch"));
    expect(replies.at(-1)).toContain("Usage: /watch");

    const dirtyLabel = `\u001b[31mTreasury\u001b[0m ${"X".repeat(120)}`;
    await bot.handleUpdate(makeTextUpdate(3, 1001, `/watch ${WATCHED_WALLET_A} ${dirtyLabel}`));
    expect(replies.at(-1)).toContain("Now watching");
    const saved = store.listWallets()[0];
    expect(saved?.label?.length).toBeLessThanOrEqual(80);
    expect(saved?.label).not.toContain("\u001b");

    await bot.handleUpdate(makeTextUpdate(23, 1001, `/watch ${WATCHED_WALLET_A}`));
    expect(replies.at(-1)).toContain("already watched");

    await bot.handleUpdate(makeTextUpdate(4, 1001, "/list"));
    expect(replies.at(-1)).toContain("Treasury");

    await bot.handleUpdate(makeTextUpdate(5, 1001, "/recent"));
    expect(replies.at(-1)).toContain("No alert deliveries");

    store.recordDelivery({
      walletAddress: parseWalletAddress(WATCHED_WALLET_A),
      signature: parseTxSignature(SIG_SOL_IN),
      eventKind: "sol_transfer",
      summary: "+2.5 SOL (received)",
      channel: "telegram",
      status: "sent",
    });
    await bot.handleUpdate(makeTextUpdate(24, 1001, "/recent"));
    expect(replies.at(-1)).toContain("+2.5 SOL");

    await bot.handleUpdate(makeTextUpdate(6, 1001, "/status"));
    expect(replies.at(-1)).toContain("Watched wallets: 1");

    await bot.handleUpdate(makeTextUpdate(7, 1001, `/unwatch ${WATCHED_WALLET_A}`));
    expect(replies.at(-1)).toContain("Stopped watching");
    expect(store.listWallets()).toHaveLength(0);

    await bot.handleUpdate(makeTextUpdate(25, 1001, `/unwatch ${WATCHED_WALLET_A}`));
    expect(replies.at(-1)).toContain("was not in your watchlist");

    await bot.handleUpdate(makeTextUpdate(26, 1001, "/unwatch bad-addr"));
    expect(replies.at(-1)).toContain("Usage: /unwatch");

    await bot.handleUpdate(makeTextUpdate(8, 1001, "/watch bad-addr"));
    expect(replies.at(-1)).toContain("Invalid Solana wallet");

    // Empty allowlist fails closed silently (0 extra replies)
    const countBeforeLocked = replies.length;
    const lockedBot = createTelegramBot({
      botToken: "BOT_TOKEN",
      allowedChatIds: [],
      service,
      store,
      cluster: "mainnet-beta",
      getStatus: () => ({ running: true, watchedCount: 0, reconnectsTotal: 0 }),
      logger: createLogger("silent"),
      botInfo: bot.botInfo,
    });
    await lockedBot.handleUpdate(makeTextUpdate(9, 1001, "/list"));
    expect(replies).toHaveLength(countBeforeLocked);

    // Group chat ACL: read commands permitted in allowlisted group, mutations scoped to allowedUserIds
    const groupBotNoAdmins = createTelegramBot({
      botToken: "BOT_TOKEN",
      allowedChatIds: ["-100555"],
      service,
      store,
      cluster: "mainnet-beta",
      getStatus: () => ({ running: true, watchedCount: 0, reconnectsTotal: 0 }),
      logger: createLogger("silent"),
      botInfo: bot.botInfo,
    });
    await groupBotNoAdmins.handleUpdate(
      makeTextUpdate(30, -100555, `/watch ${WATCHED_WALLET_A}`, {
        userId: 777,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toBe("Permission denied.");
    expect(store.listWallets()).toHaveLength(0);

    const groupBotWithAdmins = createTelegramBot({
      botToken: "BOT_TOKEN",
      allowedChatIds: ["-100555"],
      allowedUserIds: ["777"],
      service,
      store,
      cluster: "mainnet-beta",
      getStatus: () => ({ running: true, watchedCount: store.countWallets(), reconnectsTotal: 0 }),
      logger: createLogger("silent"),
      botInfo: bot.botInfo,
    });
    await groupBotWithAdmins.handleUpdate(
      makeTextUpdate(31, -100555, `/watch ${WATCHED_WALLET_A} GroupAdmin`, {
        userId: 888,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toBe("Permission denied.");

    await groupBotWithAdmins.handleUpdate(
      makeTextUpdate(32, -100555, `/watch ${WATCHED_WALLET_A} GroupAdmin`, {
        userId: 777,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toContain("Now watching");

    await groupBotWithAdmins.handleUpdate(
      makeTextUpdate(33, -100555, `/watch ${COUNTERPARTY_WALLET} Second`, {
        userId: 777,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toContain("Now watching");

    // 3rd distinct wallet exceeds maxWatchedWallets=2
    await groupBotWithAdmins.handleUpdate(
      makeTextUpdate(34, -100555, "/watch 11111111111111111111111111111111 Third", {
        userId: 777,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toContain("Wallet limit reached");

    await groupBotWithAdmins.handleUpdate(
      makeTextUpdate(35, -100555, `/unwatch ${WATCHED_WALLET_A}`, {
        userId: 888,
        chatType: "supergroup",
      }),
    );
    expect(replies.at(-1)).toBe("Permission denied.");

    store.close();
  });
});
