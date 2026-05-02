import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { SmartScalingDecision, SmartScalingInput } from "./types";

export function evaluateSmartScaling(input: SmartScalingInput): SmartScalingDecision {
  const cfg = BLACK_GOAT_V3_CONFIG.smartScalingEngine;
  const positionProbability =
    input.position.side === "YES" ? input.currentForecast.probabilityFinalAbove : input.currentForecast.probabilityFinalBelow;
  const edgeNet = input.position.side === "YES" ? input.currentOpportunity.edgeYesNet : input.currentOpportunity.edgeNoNet;
  const currentAsk = input.position.side === "YES" ? input.currentYesAsk : input.currentNoAsk;
  const sameForecast =
    (input.position.side === "YES" && input.currentForecast.forecast === "ABOVE_TARGET") ||
    (input.position.side === "NO" && input.currentForecast.forecast === "BELOW_TARGET");

  if (input.currentForecast.forecast === "UNCLEAR") {
    return blocked("ADD_BLOCKED_SCENARIO_WEAKENED", "FORECAST_UNCLEAR", "No add because final settlement forecast became unclear.");
  }
  if (!sameForecast) {
    return blocked("ADD_BLOCKED_SCENARIO_WEAKENED", "FORECAST_OPPOSITE", "No add because forecast no longer matches the position.");
  }
  if (edgeNet < BLACK_GOAT_V3_CONFIG.entryOpportunityEngine.minEdgeNetForAdd) {
    return blocked("ADD_BLOCKED_EDGE_TOO_LOW", "EDGE_TOO_LOW", "No add because edge net is below add threshold.");
  }
  if ((input.position.addCount ?? 0) >= cfg.maxAddsPerMarket) {
    return blocked("ADD_BLOCKED_MAX_POSITION", "MAX_ADDS_REACHED", "No add because max adds per market is reached.");
  }
  if (input.position.entrySizeUsd >= cfg.maxPositionPerMarketUsd) {
    return blocked("ADD_BLOCKED_MAX_POSITION", "MAX_POSITION_REACHED", "No add because max position size is reached.");
  }
  if (input.timeRemainingSeconds < 60) {
    return blocked("ADD_BLOCKED_TIME", "TIME_TOO_LOW", "No add close to expiry.");
  }

  if (currentAsk < input.position.entryTokenPrice && positionProbability >= 0.56) {
    return {
      action: "VALUE_ADD_APPROVED",
      addSizeUsd: Math.min(1, cfg.maxPositionPerMarketUsd - input.position.entrySizeUsd),
      explanation: "Value add approved: token cheaper while final settlement scenario remains valid.",
      reasonCodes: ["VALUE_ADD", "SAME_FORECAST", "EDGE_POSITIVE"],
    };
  }
  if (currentAsk > input.position.entryTokenPrice && positionProbability >= 0.64 && edgeNet >= 0.08 && currentAsk <= 0.72) {
    return {
      action: "CONFIRMATION_ADD_APPROVED",
      addSizeUsd: Math.min(0.6, cfg.maxPositionPerMarketUsd - input.position.entrySizeUsd),
      explanation: "Confirmation add approved: probability improved faster than market price.",
      reasonCodes: ["CONFIRMATION_ADD", "PROBABILITY_IMPROVED", "EDGE_POSITIVE"],
    };
  }

  return {
    action: "NO_ADD",
    explanation: "No add: scaling conditions are not strong enough.",
    reasonCodes: ["NO_SCALING_SIGNAL"],
  };
}

function blocked(action: SmartScalingDecision["action"], code: string, explanation: string): SmartScalingDecision {
  return { action, explanation, reasonCodes: [code] };
}
