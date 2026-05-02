import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { OpeningScenario, OpeningScenarioInput, OpeningScenarioResult } from "./types";

export function createOpeningScenarios(input: OpeningScenarioInput): OpeningScenarioResult {
  const cfg = BLACK_GOAT_V3_CONFIG.openingScenarioBot;
  const gap = Math.abs(input.finalSettlementForecast.probabilityFinalAbove - input.finalSettlementForecast.probabilityFinalBelow);
  const distanceToTargetUsd = input.currentPrice - input.targetPrice;
  const distanceToTargetBps = (distanceToTargetUsd / Math.max(input.targetPrice, 1)) * 10_000;
  const aboveEdgeNet = input.opportunity.edgeYesNet;
  const belowEdgeNet = input.opportunity.edgeNoNet;
  const scenarioA = buildScenario({
    confidence: input.finalSettlementForecast.forecast === "ABOVE_TARGET" ? input.finalSettlementForecast.confidence : input.finalSettlementForecast.confidence * 0.82,
    distanceToTargetBps,
    distanceToTargetUsd,
    edgeNet: aboveEdgeNet,
    input,
    label: "ABOVE_TARGET",
    maxAcceptableAskPrice: input.opportunity.maxAcceptableYesPrice,
    probability: input.finalSettlementForecast.probabilityFinalAbove,
    scenarioId: "A",
    side: "YES",
  });
  const scenarioB = buildScenario({
    confidence: input.finalSettlementForecast.forecast === "BELOW_TARGET" ? input.finalSettlementForecast.confidence : input.finalSettlementForecast.confidence * 0.82,
    distanceToTargetBps,
    distanceToTargetUsd,
    edgeNet: belowEdgeNet,
    input,
    label: "BELOW_TARGET",
    maxAcceptableAskPrice: input.opportunity.maxAcceptableNoPrice,
    probability: input.finalSettlementForecast.probabilityFinalBelow,
    scenarioId: "B",
    side: "NO",
  });
  const scenarioC: OpeningScenario = {
    confidence: Math.max(0.3, 1 - input.finalSettlementForecast.confidence),
    distanceToTargetBps,
    distanceToTargetUsd,
    entryPlan: "NO_TRADE",
    expectedFinalPosition: "UNCLEAR",
    expectedPath: "Chop autour de la target ou signaux contradictoires jusqu'a l'expiration.",
    explanation: "UNCLEAR_CHOP: probabilites proches ou momentum insuffisant, observation uniquement.",
    invalidationCondition: "Un scenario ABOVE/BELOW reprend au moins 6 points de probabilite d'avance avec edge net positif.",
    label: "UNCLEAR_CHOP",
    openingPrice: input.openingCryptoPrice,
    probability: Math.max(0, 1 - Math.max(scenarioA.probability, scenarioB.probability)),
    reasonCodes: ["UNCLEAR_CHOP_BASELINE"],
    scenarioId: "C",
    side: "NONE",
    targetPrice: input.targetPrice,
  };

  const scenarios = [scenarioA, scenarioB, scenarioC] satisfies OpeningScenario[];
  const directionalPrimary = scenarioA.probability >= scenarioB.probability ? scenarioA : scenarioB;
  const directionalSecondary = directionalPrimary.scenarioId === "A" ? scenarioB : scenarioA;
  const forceUnclear =
    input.finalSettlementForecast.forecast === "UNCLEAR" ||
    gap < cfg.scenarioSelection.minProbabilityGapToAvoidUnclear ||
    directionalPrimary.confidence < cfg.scenarioSelection.minPrimaryScenarioConfidence ||
    directionalPrimary.probability < cfg.scenarioSelection.minPrimaryScenarioProbability;
  const primaryScenario = forceUnclear ? scenarioC : directionalPrimary;
  const secondaryScenario = primaryScenario.scenarioId === "C" ? directionalPrimary : directionalSecondary;
  const dangerScenario = primaryScenario.scenarioId === "A" ? scenarioB : primaryScenario.scenarioId === "B" ? scenarioA : scenarioC;
  const forcedDirection = scenarioA.probability > scenarioB.probability ? scenarioA : scenarioB;
  const openingDecision = resolveOpeningDecision(primaryScenario, input.opportunity);
  const primaryScenarioKeptDespiteNoTrade =
    primaryScenario.scenarioId !== "C" && openingDecision !== "ENTER_AT_OPEN" && openingDecision !== "WAIT_FOR_CONFIRMATION";

  return {
    asset: input.asset,
    currentPrice: input.currentPrice,
    dangerScenario,
    explanation: `${openingDecision}: primary ${primaryScenario.label}, A ${(scenarioA.probability * 100).toFixed(1)}%, B ${(scenarioB.probability * 100).toFixed(1)}%, gap ${(gap * 100).toFixed(1)}%.`,
    forcedPaperPick: {
      confidence: forcedDirection.confidence,
      reason: `Forced opening pick ${forcedDirection.side}: ${forcedDirection.label} has the stronger final settlement probability.`,
      scenarioId: forcedDirection.scenarioId as "A" | "B",
      side: forcedDirection.side as "YES" | "NO",
    },
    marketId: input.marketId,
    openingCryptoPrice: input.openingCryptoPrice,
    openingDecision,
    primaryScenario,
    primaryScenarioKeptDespiteNoTrade,
    scenarios,
    secondaryScenario,
    targetPrice: input.targetPrice,
  };
}

function buildScenario({
  confidence,
  distanceToTargetBps,
  distanceToTargetUsd,
  edgeNet,
  input,
  label,
  maxAcceptableAskPrice,
  probability,
  scenarioId,
  side,
}: {
  confidence: number;
  distanceToTargetBps: number;
  distanceToTargetUsd: number;
  edgeNet: number;
  input: OpeningScenarioInput;
  label: "ABOVE_TARGET" | "BELOW_TARGET";
  maxAcceptableAskPrice: number;
  probability: number;
  scenarioId: "A" | "B";
  side: "YES" | "NO";
}): OpeningScenario {
  const ask = side === "YES" ? input.yesAsk : input.noAsk;
  const edgeOk = edgeNet >= BLACK_GOAT_V3_CONFIG.openingScenarioBot.scenarioSelection.minEdgeNetForPrimaryScenario;
  const priceOk = ask <= maxAcceptableAskPrice;
  const confident = confidence >= BLACK_GOAT_V3_CONFIG.openingScenarioBot.scenarioSelection.minPrimaryScenarioConfidence;
  const entryPlan = edgeOk && priceOk && confident ? "ENTER_AT_OPEN" : !priceOk ? "WAIT_FOR_BETTER_PRICE" : "WAIT_FOR_CONFIRMATION";
  const expectedFinalPosition = label === "ABOVE_TARGET" ? "ABOVE" : "BELOW";
  const directionText = label === "ABOVE_TARGET" ? "au-dessus" : "en dessous";

  return {
    confidence,
    distanceToTargetBps,
    distanceToTargetUsd,
    entryPlan,
    expectedFinalPosition,
    expectedPath: `Le prix final termine ${directionText} de la target a l'expiration, pas seulement une touche intraperiode.`,
    explanation: `${label}: probability ${(probability * 100).toFixed(1)}%, edge net ${(edgeNet * 100).toFixed(1)}%, ask ${(ask * 100).toFixed(1)}c.`,
    invalidationCondition:
      label === "ABOVE_TARGET"
        ? "Forecast passe BELOW_TARGET ou probabilityFinalAbove retombe sous 50%."
        : "Forecast passe ABOVE_TARGET ou probabilityFinalBelow retombe sous 50%.",
    label,
    maxAcceptableAskPrice,
    openingPrice: input.openingCryptoPrice,
    probability,
    reasonCodes: [
      `${label}_SCENARIO`,
      edgeOk ? "EDGE_OK" : "EDGE_TOO_LOW",
      priceOk ? "ASK_ACCEPTABLE" : "ASK_TOO_EXPENSIVE",
      confident ? "CONFIDENCE_OK" : "CONFIDENCE_TOO_LOW",
    ],
    scenarioId,
    side,
    targetPrice: input.targetPrice,
  };
}

function resolveOpeningDecision(primaryScenario: OpeningScenario, opportunity: OpeningScenarioInput["opportunity"]): OpeningScenarioResult["openingDecision"] {
  if (primaryScenario.label === "UNCLEAR_CHOP") return "NO_TRADE";
  if (opportunity.decision === "NO_TRADE_PRICE_TOO_EXPENSIVE") return "NO_TRADE_PRICE_TOO_EXPENSIVE";
  return primaryScenario.entryPlan;
}
