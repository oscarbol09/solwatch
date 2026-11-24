import {
  formatDisplaySol,
  formatDisplayUnits,
  formatGroupedInteger,
  formatUnits,
  formatUsdValue,
  shortAddress,
} from "../domain/tokens.js";
import { assertNever, type OnChainEvent, type SolanaCluster } from "../domain/types.js";
import { escapeDiscordMarkdown, sanitizeControlChars } from "../security/sanitize.js";
import type { AlertEnvelope } from "./types.js";

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function solscanTxUrl(signature: string, cluster: SolanaCluster): string {
  const base = `https://solscan.io/tx/${signature}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}

export function solscanAccountUrl(address: string, cluster: SolanaCluster): string {
  const base = `https://solscan.io/account/${address}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}

export function solscanTokenUrl(mint: string, cluster: SolanaCluster): string {
  const base = `https://solscan.io/token/${mint}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}

export function dexScreenerTokenUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

function formatUtcTimestamp(timestampSec: number | null): string | null {
  if (
    timestampSec === null ||
    !Number.isFinite(timestampSec) ||
    timestampSec < 0 ||
    timestampSec > 8_640_000_000
  ) {
    return null;
  }
  return new Date(timestampSec * 1_000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function summarizeEvent(event: OnChainEvent, estimatedUsd?: number | null): string {
  const usdSuffix =
    estimatedUsd !== null && estimatedUsd !== undefined && Number.isFinite(estimatedUsd)
      ? ` (~${formatUsdValue(estimatedUsd)})`
      : "";

  switch (event.kind) {
    case "sol_transfer": {
      const sign = event.direction === "in" ? "+" : "-";
      return `${sign}${formatDisplaySol(event.lamports)} SOL (${event.direction === "in" ? "received" : "sent"})${usdSuffix}`;
    }
    case "spl_transfer": {
      const sign = event.direction === "in" ? "+" : "-";
      const amount = formatDisplayUnits(event.rawAmount, event.decimals);
      const safeSymbol = sanitizeControlChars(event.symbol, 32) || "TOKEN";
      return `${sign}${amount} ${safeSymbol} (${event.direction === "in" ? "received" : "sent"})${usdSuffix}`;
    }
    case "dex_swap": {
      const inAmt = formatDisplayUnits(event.tokenIn.rawAmount, event.tokenIn.decimals);
      const outAmt = formatDisplayUnits(event.tokenOut.rawAmount, event.tokenOut.decimals);
      const safeDex = sanitizeControlChars(event.dex, 48) || "DEX";
      const safeInSymbol = sanitizeControlChars(event.tokenIn.symbol, 32) || "IN";
      const safeOutSymbol = sanitizeControlChars(event.tokenOut.symbol, 32) || "OUT";
      return `Swap on ${safeDex}: ${inAmt} ${safeInSymbol} -> ${outAmt} ${safeOutSymbol}${usdSuffix}`;
    }
    case "program_interaction":
      return `${sanitizeControlChars(event.summary, 240)}${usdSuffix}`;
    default:
      return assertNever(event);
  }
}

export type BuildAlertEnvelopeOptions = {
  readonly estimatedUsd?: number | null | undefined;
  readonly source?: AlertEnvelope["source"];
};

export function buildAlertEnvelope(
  event: OnChainEvent,
  walletLabel: string | null,
  cluster: SolanaCluster,
  deliveryId: string,
  options: BuildAlertEnvelopeOptions = {},
): AlertEnvelope {
  const safeLabel = walletLabel !== null ? sanitizeControlChars(walletLabel, 80) || null : null;
  const estimatedUsd = options.estimatedUsd ?? null;
  return {
    deliveryId,
    cluster,
    walletLabel: safeLabel,
    event,
    summary: summarizeEvent(event, estimatedUsd),
    explorerUrl: solscanTxUrl(event.signature, cluster),
    estimatedUsd,
    source: options.source ?? "websocket",
  };
}

function eventTitle(event: OnChainEvent): string {
  if (!event.success) return "Failed Solana Transaction";
  switch (event.kind) {
    case "sol_transfer":
      return event.direction === "in" ? "SOL Received" : "SOL Sent";
    case "spl_transfer": {
      const safeSymbol = sanitizeControlChars(event.symbol, 32) || "TOKEN";
      return event.direction === "in" ? `${safeSymbol} Received` : `${safeSymbol} Sent`;
    }
    case "dex_swap": {
      const safeDex = sanitizeControlChars(event.dex, 48) || "DEX";
      return `${safeDex} Swap Executed`;
    }
    case "program_interaction":
      return "Program Interaction";
    default:
      return assertNever(event);
  }
}

function eventColor(event: OnChainEvent): number {
  if (!event.success) return 0xef4444;
  switch (event.kind) {
    case "sol_transfer":
    case "spl_transfer":
      return event.direction === "in" ? 0x14f195 : 0xf59e0b;
    case "dex_swap":
      return 0x9945ff;
    case "program_interaction":
      return 0x6366f1;
    default:
      return assertNever(event);
  }
}

function sourceBadge(source: AlertEnvelope["source"]): string {
  if (source === "backfill") return "[BACKFILL] ";
  if (source === "test") return "[TEST] ";
  return "";
}

export function formatTelegramHtml(envelope: AlertEnvelope): string {
  const { event, walletLabel, summary, explorerUrl, cluster, source } = envelope;
  const escapedWallet = escapeHtml(sanitizeControlChars(shortAddress(event.wallet)));
  const walletLink = `<a href="${escapeHtml(solscanAccountUrl(event.wallet, cluster))}"><code>${escapedWallet}</code></a>`;
  const safeLabel = walletLabel ? sanitizeControlChars(walletLabel, 80) : null;
  const walletHeading = safeLabel ? `${escapeHtml(safeLabel)} (${walletLink})` : walletLink;
  const clusterTag = cluster === "mainnet-beta" ? "" : ` [${escapeHtml(cluster.toUpperCase())}]`;
  const prefix = sourceBadge(source);

  const lines = [
    `<b>${escapeHtml(prefix + sanitizeControlChars(eventTitle(event)))}${clusterTag}</b>`,
    `<b>Wallet:</b> ${walletHeading}`,
    `<b>Action:</b> ${escapeHtml(sanitizeControlChars(summary, 300))}`,
  ];

  if (event.kind === "sol_transfer" || event.kind === "spl_transfer") {
    if (event.counterparty) {
      const escapedCounterparty = escapeHtml(
        sanitizeControlChars(shortAddress(event.counterparty)),
      );
      lines.push(
        `<b>Counterparty:</b> <a href="${escapeHtml(solscanAccountUrl(event.counterparty, cluster))}"><code>${escapedCounterparty}</code></a>`,
      );
    }
  }

  lines.push(
    `<b>Fee:</b> ${formatDisplaySol(event.feeLamports, 6)} SOL | <b>Slot:</b> ${formatGroupedInteger(event.slot.toString())}`,
  );

  const utcTime = formatUtcTimestamp(event.timestampSec);
  if (utcTime) {
    lines.push(`<b>Time:</b> ${escapeHtml(utcTime)}`);
  }

  lines.push(`<a href="${escapeHtml(explorerUrl)}">Open on Solscan</a>`);
  return lines.join("\n");
}

export type DiscordWebhookPayload = {
  readonly username: string;
  readonly allowed_mentions: {
    readonly parse: readonly [];
  };
  readonly embeds: readonly [
    {
      readonly title: string;
      readonly description: string;
      readonly url: string;
      readonly color: number;
      readonly fields: ReadonlyArray<{
        readonly name: string;
        readonly value: string;
        readonly inline?: boolean;
      }>;
      readonly footer: { readonly text: string };
      readonly timestamp?: string;
    },
  ];
};

export function formatDiscordEmbed(envelope: AlertEnvelope): DiscordWebhookPayload {
  const { event, walletLabel, summary, explorerUrl, cluster, estimatedUsd, source } = envelope;
  const safeWallet = escapeDiscordMarkdown(sanitizeControlChars(shortAddress(event.wallet)));
  const safeLabel = walletLabel
    ? escapeDiscordMarkdown(sanitizeControlChars(walletLabel, 80))
    : null;

  const fields: Array<{
    readonly name: string;
    readonly value: string;
    readonly inline?: boolean;
  }> = [
    {
      name: "Wallet",
      value: safeLabel ? `${safeLabel} (${safeWallet})` : safeWallet,
      inline: true,
    },
    {
      name: "Cluster",
      value: cluster,
      inline: true,
    },
    {
      name: "Fee",
      value: `${formatDisplaySol(event.feeLamports, 6)} SOL`,
      inline: true,
    },
  ];

  if (estimatedUsd !== null && estimatedUsd !== undefined && Number.isFinite(estimatedUsd)) {
    fields.push({
      name: "Est. Value",
      value: formatUsdValue(estimatedUsd),
      inline: true,
    });
  }

  if ((event.kind === "sol_transfer" || event.kind === "spl_transfer") && event.counterparty) {
    const safeCounterparty = escapeDiscordMarkdown(
      sanitizeControlChars(shortAddress(event.counterparty)),
    );
    fields.push({
      name: "Counterparty",
      value: `\`${safeCounterparty}\``,
      inline: true,
    });
  }

  const footerSuffix = source === "backfill" ? " • BACKFILL" : source === "test" ? " • TEST" : "";
  const prefix = sourceBadge(source);
  const embedBase = {
    title: escapeDiscordMarkdown(sanitizeControlChars(prefix + eventTitle(event), 120)),
    description: escapeDiscordMarkdown(sanitizeControlChars(summary, 300)),
    url: explorerUrl,
    color: eventColor(event),
    fields,
    footer: {
      text: `solwatch • slot ${formatGroupedInteger(event.slot.toString())}${footerSuffix}`,
    },
  };

  const safeTimestamp =
    event.timestampSec !== null &&
    Number.isFinite(event.timestampSec) &&
    event.timestampSec >= 0 &&
    event.timestampSec <= 8_640_000_000
      ? new Date(event.timestampSec * 1_000).toISOString()
      : undefined;

  return {
    username: "solwatch",
    allowed_mentions: { parse: [] },
    embeds: [safeTimestamp !== undefined ? { ...embedBase, timestamp: safeTimestamp } : embedBase],
  };
}

export function formatWebhookPayload(envelope: AlertEnvelope) {
  const { event } = envelope;
  const serializedEvent = (() => {
    switch (event.kind) {
      case "sol_transfer":
        return {
          kind: event.kind,
          signature: event.signature,
          slot: event.slot.toString(),
          timestampSec: event.timestampSec,
          wallet: event.wallet,
          direction: event.direction,
          counterparty: event.counterparty,
          lamports: event.lamports.toString(),
          uiAmount: formatUnits(event.lamports, 9, 9),
          feeLamports: event.feeLamports.toString(),
          success: event.success,
        };
      case "spl_transfer":
        return {
          kind: event.kind,
          signature: event.signature,
          slot: event.slot.toString(),
          timestampSec: event.timestampSec,
          wallet: event.wallet,
          direction: event.direction,
          mint: event.mint,
          symbol: event.symbol,
          rawAmount: event.rawAmount.toString(),
          decimals: event.decimals,
          uiAmount: formatUnits(event.rawAmount, event.decimals, event.decimals),
          counterparty: event.counterparty,
          feeLamports: event.feeLamports.toString(),
          success: event.success,
        };
      case "dex_swap":
        return {
          kind: event.kind,
          signature: event.signature,
          slot: event.slot.toString(),
          timestampSec: event.timestampSec,
          wallet: event.wallet,
          dex: event.dex,
          programId: event.programId,
          tokenIn: {
            mint: event.tokenIn.mint,
            symbol: event.tokenIn.symbol,
            rawAmount: event.tokenIn.rawAmount.toString(),
            decimals: event.tokenIn.decimals,
            uiAmount: formatUnits(
              event.tokenIn.rawAmount,
              event.tokenIn.decimals,
              event.tokenIn.decimals,
            ),
          },
          tokenOut: {
            mint: event.tokenOut.mint,
            symbol: event.tokenOut.symbol,
            rawAmount: event.tokenOut.rawAmount.toString(),
            decimals: event.tokenOut.decimals,
            uiAmount: formatUnits(
              event.tokenOut.rawAmount,
              event.tokenOut.decimals,
              event.tokenOut.decimals,
            ),
          },
          feeLamports: event.feeLamports.toString(),
          success: event.success,
        };
      case "program_interaction":
        return {
          kind: event.kind,
          signature: event.signature,
          slot: event.slot.toString(),
          timestampSec: event.timestampSec,
          wallet: event.wallet,
          programIds: event.programIds,
          summary: event.summary,
          feeLamports: event.feeLamports.toString(),
          success: event.success,
        };
      default:
        return assertNever(event);
    }
  })();

  return {
    schemaVersion: "1.1",
    deliveryId: envelope.deliveryId,
    source: envelope.source ?? "websocket",
    cluster: envelope.cluster,
    walletLabel: envelope.walletLabel,
    summary: envelope.summary,
    estimatedUsd: envelope.estimatedUsd ?? null,
    explorerUrl: envelope.explorerUrl,
    event: serializedEvent,
  };
}

export function formatConsoleLine(envelope: AlertEnvelope): string {
  const safeLabel = envelope.walletLabel
    ? sanitizeControlChars(envelope.walletLabel, 80)
    : sanitizeControlChars(shortAddress(envelope.event.wallet));
  const safeSummary = sanitizeControlChars(envelope.summary, 300);
  const statusTag = envelope.event.success ? "OK" : "FAIL";
  const prefix = sourceBadge(envelope.source);
  return [
    `[${statusTag}] ${prefix}[${safeLabel || shortAddress(envelope.event.wallet)}] ${safeSummary}`,
    `  tx: ${envelope.event.signature} | slot: ${envelope.event.slot.toString()}`,
    `  url: ${envelope.explorerUrl}\n`,
  ].join("\n");
}
