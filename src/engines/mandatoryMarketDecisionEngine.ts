import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { Crypto5mMarket, EntryOpportunityResult, FinalSettlementForecast, ForcedPaperPick, MandatoryDecisionResult, RiskDecision } from "./types";

export function createForcedPaperPick({
  forecast,
  opportunity,
}: {
  forecast: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
}): ForcedPaperPick {
  const side = forecast.probabilityFinalAbove > forecast.probabilityFinalBelow ? "YES" : "NO";
  return {
    blockedReason: opportunity.decision === "STARTER_ENTRY_APPROVED" ? undefined : opportunity.decision,
    confidence: side === "YES" ? forecast.probabilityFinalAbove : forecast.probabilityFinalBelow,
    reason: `Forced paper pick ${side}: final above ${(forecast.probabilityFinalAbove * 100).toFixed(1)}%, final below ${(forecast.probabilityFinalBelow * 100).toFixed(1)}%.`,
    side,
    wouldHaveEntered: opportunity.decision === "STARTER_ENTRY_APPROVED" && opportunity.bestSide === side,
  };
}

export function decideMandatoryMarket({
  forecast,
  forcedPaperPick,
  market,
  opportunity,
  riskDecision,
}: {
  market: Crypto5mMarket;
  forecast: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
  forcedPaperPick: ForcedPaperPick;
  riskDecision: RiskDecision;
}): MandatoryDecisionResult {
  const reasonCodes = [...forecast.reasonCodes, ...opportunity.reasonCodes, ...riskDecision.blockedBy];
  let status: MandatoryDecisionResult["status"] = "FORCED_PAPER_PICK_ONLY";

  if ((market.spreadPercent ?? Number.POSITIVE_INFINITY) > BLACK_GOAT_V3_CONFIG.marketQuality.maxSpreadPercent) {
    status = "NO_TRADE_WIDE_SPREAD";
  } else if ((market.liquidityScore ?? 0) < BLACK_GOAT_V3_CONFIG.marketQuality.minLiquidityScore) {
    status = "NO_TRADE_LOW_LIQUIDITY";
  } else if (!riskDecision.approved) {
    status = "NO_TRADE_RISK_BLOCKED";
  } else if (opportunity.decision === "STARTER_ENTRY_APPROVED") {
    status = "STARTER_ENTRY_APPROVED";
  } else if (opportunity.decision === "WAITING_FOR_CLARITY") {
    status = "WAITING_FOR_CLARITY";
  } else if (opportunity.decision === "NO_TRADE_PRICE_TOO_EXPENSIVE") {
    status = "NO_TRADE_PRICE_TOO_EXPENSIVE";
  } else if (opportunity.decision === "WAITING_FOR_BETTER_PRICE") {
    status = "WAITING_FOR_BETTER_PRICE";
  }

  const starterEntryApproved = status === "STARTER_ENTRY_APPROVED" && opportunity.bestSide !== "NONE";
  return {
    explanation: `${status}: forced pick ${forcedPaperPick.side}, opportunity ${opportunity.bestSide}.`,
    forcedPaperPick,
    reasonCodes,
    side: starterEntryApproved ? opportunity.bestSide : "NONE",
    starterEntryApproved,
    starterSizeUsd: starterEntryApproved ? Math.min(BLACK_GOAT_V3_CONFIG.starterEntry.maxStarterStakeUsd, riskDecision.adjustedPositionSize) : 0,
    status,
  };
}
