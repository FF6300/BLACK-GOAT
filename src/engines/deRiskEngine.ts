import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { DeRiskDecision, DeRiskInput } from "./types";

export function evaluateDeRisk(input: DeRiskInput): DeRiskDecision {
  const cfg = BLACK_GOAT_V3_CONFIG.deRiskEngine;
  const positionProbability =
    input.position.side === "YES" ? input.forecast.probabilityFinalAbove : input.forecast.probabilityFinalBelow;
  const edgeNet = input.position.side === "YES" ? input.opportunity.edgeYesNet : input.opportunity.edgeNoNet;
  const opposite =
    (input.position.side === "YES" && input.forecast.forecast === "BELOW_TARGET") ||
    (input.position.side === "NO" && input.forecast.forecast === "ABOVE_TARGET");

  if (cfg.exitIfForecastOpposite && opposite) {
    return decision("EXIT_OPPOSITE_FORECAST", "FORECAST_OPPOSITE", "Exit because final settlement forecast flipped against the position.");
  }
  if (input.forecast.forecast === "UNCLEAR" && cfg.exitIfForecastUnclearAndEdgeGone && edgeNet <= cfg.exitIfEdgeNetBelow) {
    return decision("EXIT_SCENARIO_INVALIDATED", "FORECAST_UNCLEAR_EDGE_GONE", "Exit because forecast is unclear and edge is gone.");
  }
  if (positionProbability < cfg.exitIfProbabilityBelow) {
    return decision("EXIT_EDGE_GONE", "POSITION_PROBABILITY_TOO_LOW", "Exit because model probability no longer supports the position.");
  }
  if (input.timeRemainingSeconds < cfg.protectProfitIfTimeRemainingBelowSeconds && edgeNet <= 0) {
    return decision("EXIT_TIME_RISK", "TIME_RISK_EDGE_GONE", "Exit due to expiry risk and no remaining edge.");
  }
  if (cfg.takePartialProfitEnabled && input.currentTokenPrice > cfg.takePartialProfitIfTokenPriceAbove && positionProbability < input.currentTokenPrice) {
    return decision("TAKE_PARTIAL_PROFIT", "TOKEN_PRICE_AHEAD_OF_MODEL", "Take partial profit because market price is ahead of model probability.");
  }

  return decision("HOLD", "SCENARIO_VALID", "Hold because the final settlement scenario remains valid.");
}

function decision(action: DeRiskDecision["action"], code: string, explanation: string): DeRiskDecision {
  return { action, explanation, reasonCodes: [code] };
}
