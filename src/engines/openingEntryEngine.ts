import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { OpeningEntryDecision, OpeningEntryInput } from "./types";

export function decideOpeningEntry(input: OpeningEntryInput): OpeningEntryDecision {
  const { market, opportunity, riskDecision, scenarioResult, settings } = input;
  const reasonCodes: string[] = [];
  const primary = scenarioResult.primaryScenario;
  const forced = scenarioResult.forcedPaperPick;
  const side = primary.side === "YES" || primary.side === "NO" ? primary.side : forced.side;
  const entryPrice = side === "YES" ? market.yesAsk : market.noAsk;
  const edgeNet = side === "YES" ? opportunity.edgeYesNet : opportunity.edgeNoNet;

  if (!settings.enabled || !settings.openAtMarketStart || settings.entryMode === "OFF") {
    return noTrade("OPENING_ENTRY_OFF", "NO_TRADE", "Opening entry is disabled.");
  }

  const criticalBlocks = getCriticalDataBlocks(input);
  if (criticalBlocks.length > 0) {
    return {
      action: "NO_TRADE",
      explanation: `Opening entry blocked: ${criticalBlocks.join(", ")}.`,
      reasonCodes: criticalBlocks,
      side: "NONE",
      sizeUsd: 0,
    };
  }

  const elapsedMs = Math.max(0, Date.now() - market.startTime);
  if (elapsedMs < settings.entryDelayMs) {
    return {
      action: "WAIT_FOR_CONFIRMATION",
      explanation: "Opening entry delay has not elapsed yet.",
      reasonCodes: ["OPENING_ENTRY_DELAY"],
      side: "NONE",
      sizeUsd: 0,
    };
  }
  const allowLateForcedEntry =
    settings.entryMode === "FORCED_MIN_STAKE_PAPER" &&
    market.timeRemainingSeconds >= 60;
  if (elapsedMs > settings.entryWindowSeconds * 1_000 && !allowLateForcedEntry) {
    return {
      action: "NO_TRADE",
      explanation: "Opening entry window has expired.",
      reasonCodes: ["OPENING_ENTRY_WINDOW_EXPIRED"],
      side: "NONE",
      sizeUsd: 0,
    };
  }

  if (settings.entryMode === "FORCED_PAPER_ONLY") {
    return {
      action: "FORCED_PAPER_PICK_ONLY",
      explanation: "Forced paper pick logged only. No position is opened in this mode.",
      reasonCodes: ["FORCED_PAPER_ONLY_MODE"],
      side: "NONE",
      sizeUsd: 0,
    };
  }

  if (settings.entryMode === "FORCED_MIN_STAKE_PAPER") {
    const forcedReasons = ["FORCED_MIN_STAKE_PAPER", `SCENARIO_${forced.scenarioId}`];
    const forcedEntryDespiteWideSpread = (market.spreadPercent ?? 0) > settings.maxSpreadPercent;
    if (forcedEntryDespiteWideSpread) {
      forcedReasons.push("FORCED_ENTRY_DESPITE_WIDE_SPREAD");
    }
    if (allowLateForcedEntry && elapsedMs > settings.entryWindowSeconds * 1_000) {
      forcedReasons.push("LATE_FORCED_ENTRY_AFTER_DATA_READY");
    }
    return {
      action: "OPEN_STARTER_POSITION",
      entryPrice: entryPrice ?? undefined,
      explanation: `Forced min stake paper entry on ${forced.side}. Critical data is valid.`,
      forcedEntryDespiteWideSpread,
      lateForcedEntryUsed: allowLateForcedEntry && elapsedMs > settings.entryWindowSeconds * 1_000,
      forcedMinStakePaperUsed: true,
      reasonCodes: forcedReasons,
      side: forced.side,
      sizeUsd: settings.minStakeUsd,
    };
  }

  if (primary.side === "NONE" || scenarioResult.openingDecision === "NO_TRADE") reasonCodes.push("PRIMARY_SCENARIO_UNCLEAR");
  if (scenarioResult.openingDecision === "WAIT_FOR_BETTER_PRICE") reasonCodes.push("WAIT_FOR_BETTER_PRICE");
  if (scenarioResult.openingDecision === "WAIT_FOR_CONFIRMATION") reasonCodes.push("WAIT_FOR_CONFIRMATION");
  if (scenarioResult.openingDecision === "NO_TRADE_PRICE_TOO_EXPENSIVE") reasonCodes.push("NO_TRADE_PRICE_TOO_EXPENSIVE");
  if (primary.confidence < settings.minConfidenceForOpeningEntry) reasonCodes.push("OPENING_CONFIDENCE_TOO_LOW");
  if (edgeNet < settings.minEdgeNetForOpeningEntry) reasonCodes.push("OPENING_EDGE_TOO_LOW");
  if ((market.spreadPercent ?? Number.POSITIVE_INFINITY) > settings.maxSpreadPercent) reasonCodes.push("OPENING_SPREAD_TOO_WIDE");
  if ((market.liquidityScore ?? 0) < settings.minLiquidityScore) reasonCodes.push("OPENING_LIQUIDITY_TOO_LOW");
  if (market.timeRemainingSeconds < BLACK_GOAT_V3_CONFIG.starterEntry.minTimeRemainingSeconds) reasonCodes.push("TIME_REMAINING_TOO_LOW");
  if (market.timeRemainingSeconds > BLACK_GOAT_V3_CONFIG.starterEntry.maxTimeRemainingSeconds) reasonCodes.push("TIME_REMAINING_TOO_HIGH");
  if (!riskDecision.approved) reasonCodes.push(...riskDecision.blockedBy);

  if (reasonCodes.includes("NO_TRADE_PRICE_TOO_EXPENSIVE")) {
    return blocked("NO_TRADE_PRICE_TOO_EXPENSIVE", reasonCodes, "Opening scenario is directional, but the YES/NO ask is too expensive.");
  }
  if (reasonCodes.includes("WAIT_FOR_BETTER_PRICE")) {
    return blocked("WAIT_FOR_BETTER_PRICE", reasonCodes, "Opening entry waits for a better YES/NO price.");
  }
  if (reasonCodes.includes("WAIT_FOR_CONFIRMATION")) {
    return blocked("WAIT_FOR_CONFIRMATION", reasonCodes, "Opening entry waits for confirmation.");
  }
  if (reasonCodes.length > 0 || entryPrice === null) {
    return blocked("NO_TRADE", reasonCodes, "Opening entry conditions are not approved.");
  }

  return {
    action: "OPEN_STARTER_POSITION",
    entryPrice,
    explanation: `Opening starter approved on ${side}: primary scenario ${primary.label}, edge net ${(edgeNet * 100).toFixed(1)}%.`,
    reasonCodes: ["OPENING_ENTRY_APPROVED", ...primary.reasonCodes],
    side,
    sizeUsd: Math.min(settings.maxOpeningStakeUsd, Math.max(settings.minStakeUsd, riskDecision.adjustedPositionSize)),
  };
}

function getCriticalDataBlocks(input: OpeningEntryInput) {
  const blocks: string[] = [];
  if (!Number.isFinite(input.market.targetPrice) || input.market.targetPrice <= 0) blocks.push("TARGET_PRICE_MISSING");
  if (input.market.yesAsk === null || input.market.noAsk === null) blocks.push("YES_NO_ASK_MISSING");
  if (input.market.timeRemainingSeconds <= 0) blocks.push("MARKET_NOT_LIVE");
  if (!input.settings.allowedAssets.includes(input.market.asset)) blocks.push("ASSET_NOT_ALLOWED");
  if (input.riskDecision.blockedBy.some((reason) => reason.toLowerCase().includes("stale"))) blocks.push("CRITICAL_DATA_STALE");
  return blocks;
}

function noTrade(code: string, action: OpeningEntryDecision["action"], explanation: string): OpeningEntryDecision {
  return { action, explanation, reasonCodes: [code], side: "NONE", sizeUsd: 0 };
}

function blocked(action: OpeningEntryDecision["action"], reasonCodes: string[], explanation: string): OpeningEntryDecision {
  return { action, explanation, reasonCodes: reasonCodes.length === 0 ? ["NO_OPENING_ENTRY"] : reasonCodes, side: "NONE", sizeUsd: 0 };
}
