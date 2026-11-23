import { WSOL_MINT } from "./tokens.js";
import {
  type AlertRule,
  assertNever,
  type EventType,
  type MintAddress,
  type OnChainEvent,
  type RuleId,
  type WalletAddress,
} from "./types.js";

export type RuleEvaluationResult =
  | { readonly matched: true; readonly matchedRuleId: RuleId; readonly reason: string }
  | { readonly matched: false; readonly matchedRuleId: null; readonly reason: string };

export class CooldownTracker {
  private static readonly MAX_ENTRIES = 10_000;
  private readonly lastTriggeredMs = new Map<string, number>();

  private key(wallet: WalletAddress, eventType: EventType): string {
    return `${wallet}:${eventType}`;
  }

  isOnCooldown(
    wallet: WalletAddress,
    eventType: EventType,
    cooldownSeconds: number,
    nowMs: number,
  ): boolean {
    if (cooldownSeconds <= 0) return false;
    const prev = this.lastTriggeredMs.get(this.key(wallet, eventType));
    if (prev === undefined) return false;
    return nowMs - prev < cooldownSeconds * 1_000;
  }

  record(wallet: WalletAddress, eventType: EventType, nowMs: number): void {
    const mapKey = this.key(wallet, eventType);
    if (this.lastTriggeredMs.has(mapKey)) {
      this.lastTriggeredMs.delete(mapKey);
    } else if (this.lastTriggeredMs.size >= CooldownTracker.MAX_ENTRIES) {
      const oldestKey = this.lastTriggeredMs.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastTriggeredMs.delete(oldestKey);
      }
    }
    this.lastTriggeredMs.set(mapKey, nowMs);
  }

  clear(): void {
    this.lastTriggeredMs.clear();
  }
}

function checkMintFilters(
  mints: readonly MintAddress[],
  allowlist: readonly MintAddress[],
  denylist: readonly MintAddress[],
): string | null {
  if (denylist.length > 0 && mints.some((mint) => denylist.includes(mint))) {
    return "mint_denylisted";
  }
  if (allowlist.length > 0 && !mints.some((mint) => allowlist.includes(mint))) {
    return "mint_not_in_allowlist";
  }
  return null;
}

function evaluateSingleRule(
  event: OnChainEvent,
  rule: AlertRule,
  cooldownTracker: CooldownTracker,
  nowMs: number,
): string | null {
  if (!event.success && !rule.includeFailed) {
    return "failed_tx_suppressed";
  }
  if (rule.eventTypes.length > 0 && !rule.eventTypes.includes(event.kind)) {
    return "event_type_filtered";
  }
  if (cooldownTracker.isOnCooldown(event.wallet, event.kind, rule.cooldownSeconds, nowMs)) {
    return "cooldown_active";
  }

  switch (event.kind) {
    case "sol_transfer":
      return event.lamports >= rule.minSolLamports ? null : "below_min_sol";
    case "spl_transfer":
      return checkMintFilters([event.mint], rule.mintAllowlist, rule.mintDenylist);
    case "dex_swap": {
      const mintReject = checkMintFilters(
        [event.tokenIn.mint, event.tokenOut.mint],
        rule.mintAllowlist,
        rule.mintDenylist,
      );
      if (mintReject !== null) return mintReject;

      const solAmounts: bigint[] = [];
      if (event.tokenIn.mint === WSOL_MINT) solAmounts.push(event.tokenIn.rawAmount);
      if (event.tokenOut.mint === WSOL_MINT) solAmounts.push(event.tokenOut.rawAmount);

      if (solAmounts.length > 0 && solAmounts.every((amt) => amt < rule.minSolLamports)) {
        return "below_min_sol";
      }
      return null;
    }
    case "program_interaction":
      return null;
    default:
      return assertNever(event);
  }
}

export function evaluateAlertRules(
  event: OnChainEvent,
  rules: readonly AlertRule[],
  cooldownTracker: CooldownTracker,
  nowMs: number = Date.now(),
): RuleEvaluationResult {
  const enabledRules = rules.filter((r) => r.enabled);
  const walletSpecific = enabledRules.filter((r) => r.walletAddress === event.wallet);
  const applicable =
    walletSpecific.length > 0
      ? walletSpecific
      : enabledRules.filter((r) => r.walletAddress === null);

  if (applicable.length === 0) {
    return { matched: false, matchedRuleId: null, reason: "no_enabled_rules" };
  }

  let lastRejectReason = "no_rule_matched";
  for (const rule of applicable) {
    const rejectReason = evaluateSingleRule(event, rule, cooldownTracker, nowMs);
    if (rejectReason === null) {
      return { matched: true, matchedRuleId: rule.id, reason: "matched" };
    }
    lastRejectReason = rejectReason;
  }

  return { matched: false, matchedRuleId: null, reason: lastRejectReason };
}
