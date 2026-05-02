import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { EntryMode, EntryOpportunityInput, EntryOpportunityResult } from "./types";

export function evaluateEntryOpportunity(input: EntryOpportunityInput): EntryOpportunityResult {
  const cfg = BLACK_GOAT_V3_CONFIG.entryOpportunityEngine;
  const spreadCost = (input.spreadPercent / 100) * cfg.spreadPenaltyMultiplier;
  const liquidityPenalty = input.liquidityScore < BLACK_GOAT_V3_CONFIG.marketQuality.minLiquidityScore ? cfg.lowLiquidityPenalty : 0;
  const uncertaintyPenalty = input.forecast.forecast === "UNCLEAR" ? cfg.uncertaintyPenalty : 0;
  const costs = cfg.safetyMargin + spreadCost + liquidityPenalty + uncertaintyPenalty;
  const edgeYes = input.forecast.probabilityFinalAbove - input.yesAsk;
  const edgeNo = input.forecast.probabilityFinalBelow - input.noAsk;
  const edgeYesNet = edgeYes - costs;
  const edgeNoNet = edgeNo - costs;
  const maxAcceptableYesPrice = Math.min(cfg.maxAcceptableAskPrice.YES, input.forecast.probabilityFinalAbove - cfg.safetyMargin);
  const maxAcceptableNoPrice = Math.min(cfg.maxAcceptableAskPrice.NO, input.forecast.probabilityFinalBelow - cfg.safetyMargin);
  const isYesUndervalued = edgeYesNet >= cfg.minEdgeNetForStarter && input.yesAsk <= cfg.maxAcceptableAskPrice.YES;
  const isNoUndervalued = edgeNoNet >= cfg.minEdgeNetForStarter && input.noAsk <= cfg.maxAcceptableAskPrice.NO;
  const reasonCodes: string[] = [];
  let bestSide: "YES" | "NO" | "NONE" = "NONE";
  let entryMode: EntryMode = "NO_EDGE";
  let decision: EntryOpportunityResult["decision"] = "NO_TRADE";

  if (input.forecast.forecast === "UNCLEAR") {
    reasonCodes.push("FORECAST_UNCLEAR");
    entryMode = "UNCLEAR";
    decision = "WAITING_FOR_CLARITY";
  } else if (input.forecast.forecast === "ABOVE_TARGET") {
    if (input.yesAsk > cfg.maxAcceptableAskPrice.YES) {
      reasonCodes.push("YES_ASK_ABOVE_MAX_ACCEPTABLE");
      decision = "NO_TRADE_PRICE_TOO_EXPENSIVE";
    } else if (!isYesUndervalued) {
      reasonCodes.push("YES_EDGE_TOO_LOW");
      decision = "WAITING_FOR_BETTER_PRICE";
    } else {
      bestSide = "YES";
      entryMode = input.yesAsk <= cfg.valueEntryMaxAsk ? "ABOVE_VALUE_ENTRY" : "ABOVE_CONFIRMATION_ENTRY";
      decision = "STARTER_ENTRY_APPROVED";
      reasonCodes.push("YES_UNDERVALUED_VS_FINAL_PROBABILITY");
    }
  } else if (input.forecast.forecast === "BELOW_TARGET") {
    if (input.noAsk > cfg.maxAcceptableAskPrice.NO) {
      reasonCodes.push("NO_ASK_ABOVE_MAX_ACCEPTABLE");
      decision = "NO_TRADE_PRICE_TOO_EXPENSIVE";
    } else if (!isNoUndervalued) {
      reasonCodes.push("NO_EDGE_TOO_LOW");
      decision = "WAITING_FOR_BETTER_PRICE";
    } else {
      bestSide = "NO";
      entryMode = input.noAsk <= cfg.valueEntryMaxAsk ? "BELOW_VALUE_ENTRY" : "BELOW_CONFIRMATION_ENTRY";
      decision = "STARTER_ENTRY_APPROVED";
      reasonCodes.push("NO_UNDERVALUED_VS_FINAL_PROBABILITY");
    }
  }

  return {
    bestSide,
    decision,
    edgeNo,
    edgeNoNet,
    edgeYes,
    edgeYesNet,
    entryMode,
    explanation: `${decision}: YES edge net ${(edgeYesNet * 100).toFixed(1)}%, NO edge net ${(edgeNoNet * 100).toFixed(1)}%.`,
    isNoUndervalued,
    isYesUndervalued,
    maxAcceptableNoPrice,
    maxAcceptableYesPrice,
    reasonCodes,
  };
}
