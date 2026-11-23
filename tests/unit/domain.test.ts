import { describe, expect, it } from "vitest";
import { parseEnvConfig, redactUrlSecrets } from "../../src/config.js";
import {
  AppError,
  AuthError,
  ConflictError,
  NotFoundError,
  NotifierError,
  RpcError,
  ValidationError,
} from "../../src/domain/errors.js";
import {
  assertNever,
  parseMintAddress,
  parseTxSignature,
  parseWalletAddress,
} from "../../src/domain/types.js";

describe("domain primitives and config", () => {
  it("validates Solana wallet, mint, and transaction signature boundaries", () => {
    const validWallet = "So11111111111111111111111111111111111111112";
    expect(parseWalletAddress(validWallet)).toBe(validWallet);
    expect(parseMintAddress(validWallet)).toBe(validWallet);
    expect(() => parseWalletAddress("not-a-solana-address")).toThrow(ValidationError);
    expect(() => parseMintAddress("0x1234")).toThrow(ValidationError);

    const validSig =
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    expect(parseTxSignature(validSig)).toBe(validSig);
    expect(() => parseTxSignature("bad-sig")).toThrow(ValidationError);
  });

  it("provides structured domain errors with status codes and retry flags", () => {
    const valErr = new ValidationError("bad input", { field: "address" });
    expect(valErr).toBeInstanceOf(AppError);
    expect(valErr.statusCode).toBe(400);
    expect(valErr.retryable).toBe(false);

    expect(new AuthError("denied").statusCode).toBe(401);
    expect(new NotFoundError("Wallet").statusCode).toBe(404);
    expect(new ConflictError("Already tracked").statusCode).toBe(409);
    expect(new RpcError("rate limited", { retryable: true }).retryable).toBe(true);
    expect(new NotifierError("telegram", "timeout", { retryable: true }).channel).toBe("telegram");
  });

  it("throws on assertNever at runtime if reached via invalid value", () => {
    const bogus = { kind: "unexpected" } as unknown as never;
    expect(() => assertNever(bogus)).toThrow("Unhandled union member");
  });

  it("parses boolean env strings explicitly and redacts secret query params in URLs", () => {
    const cfg = parseEnvConfig({
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=super-secret-123",
      SOLANA_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=super-secret-123",
      CONSOLE_ALERTS_ENABLED: "false",
      INCLUDE_FAILED_TX: "false",
      MIN_SOL_ALERT: "0.25",
      TELEGRAM_ALLOWED_CHAT_IDS: "12345, 67890",
    });

    expect(cfg.solanaCluster).toBe("devnet");
    expect(cfg.consoleAlertsEnabled).toBe(false);
    expect(cfg.includeFailedTx).toBe(false);
    expect(cfg.minSolAlertLamports).toBe(250_000_000n);
    expect(cfg.telegramAllowedChatIds).toEqual(["12345", "67890"]);

    expect(redactUrlSecrets(cfg.solanaRpcUrl)).toBe("https://mainnet.helius-rpc.com/?api-key=***");
    expect(redactUrlSecrets("not a url")).toBe("<invalid-url>");
  });

  it("fails fast on invalid environment configuration", () => {
    expect(() =>
      parseEnvConfig({
        SOLANA_RPC_URL: "not-a-url",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseEnvConfig({
        TELEGRAM_INTERACTIVE_ENABLED: "true",
      }),
    ).toThrow(ValidationError);
  });
});
