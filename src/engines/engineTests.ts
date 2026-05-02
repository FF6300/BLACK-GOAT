import assert from "node:assert/strict";
import { evaluateDataFreshness } from "./dataFreshness";
import { evaluateDeRisk } from "./deRiskEngine";
import { evaluateEntryOpportunity } from "./entryOpportunityEngine";
import { evaluateFinalSettlementForecast } from "./finalSettlementForecastEngine";
import { createForcedPaperPick, decideMandatoryMarket } from "./mandatoryMarketDecisionEngine";
import { decideOpeningEntry } from "./openingEntryEngine";
import { createOpeningScenarios } from "./openingScenarioEngine";
import { evaluateSmartScaling } from "./smartScalingEngine";
import { DEFAULT_OPENING_SCENARIO_SETTINGS } from "./v3Config";
import type { Candle, Crypto5mMarket, EntryOpportunityResult, FinalSettlementForecast, OpeningScenarioSettings, PaperPosition, RiskDecision } from "./types";

const baseForecast: FinalSettlementForecast = {
  confidence: 0.68,
  continuationScore: 72,
  currentPositionRelativeToTarget: "NEAR",
  distanceToTargetBps: 2,
  distanceToTargetPercent: 0.02,
  distanceToTargetUsd: 10,
  explanation: "test forecast",
  forecast: "ABOVE_TARGET",
  momentumDirection: "UP",
  momentumStrength: 70,
  probabilityFinalAbove: 0.68,
  probabilityFinalBelow: 0.32,
  reasonCodes: ["TEST_FORECAST"],
  reversalScore: 25,
  trendAlignmentScore: 74,
};

const baseMarket: Crypto5mMarket = {
  asset: "BTC",
  expiryTime: Date.now() + 250_000,
  liquidityScore: 80,
  marketId: "test-market",
  noAsk: 0.65,
  noBid: 0.63,
  noTokenId: "no",
  question: "BTC Up or Down 5m",
  spreadPercent: 1,
  startTime: Date.now(),
  targetPrice: 100,
  timeRemainingSeconds: 250,
  yesAsk: 0.35,
  yesBid: 0.34,
  yesTokenId: "yes",
};

const approvedRisk: RiskDecision = {
  adjustedPositionSize: 1,
  approved: true,
  blockedBy: [],
};

function forecast(overrides: Partial<FinalSettlementForecast>): FinalSettlementForecast {
  const probabilityFinalAbove = overrides.probabilityFinalAbove ?? baseForecast.probabilityFinalAbove;
  return {
    ...baseForecast,
    probabilityFinalAbove,
    probabilityFinalBelow: overrides.probabilityFinalBelow ?? 1 - probabilityFinalAbove,
    ...overrides,
  };
}

function opportunity(inputForecast: FinalSettlementForecast, yesAsk = 0.35, noAsk = 0.35, spreadPercent = 1, liquidityScore = 80) {
  return evaluateEntryOpportunity({
    forecast: inputForecast,
    liquidityScore,
    noAsk,
    spreadPercent,
    timeRemainingSeconds: 250,
    yesAsk,
  });
}

function mandatory(inputForecast: FinalSettlementForecast, entry: EntryOpportunityResult, market: Crypto5mMarket = baseMarket, risk: RiskDecision = approvedRisk) {
  const forcedPaperPick = createForcedPaperPick({ forecast: inputForecast, opportunity: entry });
  return decideMandatoryMarket({
    forecast: inputForecast,
    forcedPaperPick,
    market,
    opportunity: entry,
    riskDecision: risk,
  });
}

function candles(price = 100): Candle[] {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, index) => ({
    close: price + index * 0.1,
    high: price + index * 0.1 + 0.05,
    low: price + index * 0.1 - 0.05,
    open: price + Math.max(0, index - 1) * 0.1,
    timestamp: now - (5 - index) * 60_000,
    volume: 1,
  }));
}

function directionalCandles(start: number, step: number): Candle[] {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, index) => {
    const open = start + index * step;
    const close = open + step * 0.45;
    return {
      close,
      high: Math.max(open, close) + Math.abs(step) * 0.2,
      low: Math.min(open, close) - Math.abs(step) * 0.2,
      open,
      timestamp: now - (5 - index) * 60_000,
      volume: 10 + index,
    };
  });
}

function openingSettings(overrides: Partial<OpeningScenarioSettings> = {}): OpeningScenarioSettings {
  return { ...DEFAULT_OPENING_SCENARIO_SETTINGS, ...overrides };
}

const yesBelowTarget = forecast({
  currentPositionRelativeToTarget: "BELOW",
  distanceToTargetBps: -6,
  forecast: "ABOVE_TARGET",
  probabilityFinalAbove: 0.68,
});
const yesOpportunity = opportunity(yesBelowTarget, 0.35, 0.65);
assert.equal(yesOpportunity.bestSide, "YES");
assert.equal(mandatory(yesBelowTarget, yesOpportunity).status, "STARTER_ENTRY_APPROVED");

const noAboveTarget = forecast({
  currentPositionRelativeToTarget: "ABOVE",
  distanceToTargetBps: 6,
  forecast: "BELOW_TARGET",
  probabilityFinalAbove: 0.28,
  probabilityFinalBelow: 0.72,
});
const noOpportunity = opportunity(noAboveTarget, 0.68, 0.34);
assert.equal(noOpportunity.bestSide, "NO");
assert.equal(mandatory(noAboveTarget, noOpportunity).status, "STARTER_ENTRY_APPROVED");

const unclear = forecast({ confidence: 0.45, forecast: "UNCLEAR", probabilityFinalAbove: 0.5, probabilityFinalBelow: 0.5 });
const unclearOpportunity = opportunity(unclear, 0.35, 0.35);
assert.equal(unclearOpportunity.decision, "WAITING_FOR_CLARITY");

const tooExpensive = opportunity(yesBelowTarget, 0.8, 0.2);
assert.equal(tooExpensive.decision, "NO_TRADE_PRICE_TOO_EXPENSIVE");

const forcedPick = createForcedPaperPick({ forecast: yesBelowTarget, opportunity: unclearOpportunity });
assert.equal(forcedPick.side, "YES");
const forcedOnlyDecision = mandatory(yesBelowTarget, tooExpensive);
assert.notEqual(forcedOnlyDecision.status, "STARTER_ENTRY_APPROVED");
assert.equal(forcedOnlyDecision.starterEntryApproved, false);

const wideSpreadDecision = mandatory(yesBelowTarget, yesOpportunity, { ...baseMarket, spreadPercent: 8 });
assert.equal(wideSpreadDecision.status, "NO_TRADE_WIDE_SPREAD");

const lowLiquidityDecision = mandatory(yesBelowTarget, yesOpportunity, { ...baseMarket, liquidityScore: 20 });
assert.equal(lowLiquidityDecision.status, "NO_TRADE_LOW_LIQUIDITY");

const stale = evaluateDataFreshness({ cryptoPriceAgeMs: 5_000, forecastAgeMs: 100, polymarketBookAgeMs: 100 });
assert.equal(stale.fresh, false);
assert.ok(stale.blockedBy.includes("STALE_CRYPTO_PRICE"));

const nearTargetBullishOpen = evaluateFinalSettlementForecast({
  asset: "BTC",
  currentPrice: 100.001,
  isOpeningScenarioBot: true,
  ohlcv15m: directionalCandles(99.99, 0.0015),
  ohlcv1d: directionalCandles(99.98, 0.002),
  ohlcv1h: directionalCandles(99.99, 0.0015),
  ohlcv1m: directionalCandles(99.998, 0.001),
  ohlcv3m: directionalCandles(99.997, 0.001),
  ohlcv4h: directionalCandles(99.98, 0.002),
  ohlcv5m: directionalCandles(99.996, 0.001),
  targetPrice: 100,
  timeRemainingSeconds: 250,
});
assert.notEqual(nearTargetBullishOpen.forecast, "UNCLEAR");
assert.equal(nearTargetBullishOpen.preOpenBiasDirection, "ABOVE_TARGET");
assert.equal(nearTargetBullishOpen.openingNearTargetOverrideUsed, true);

const nearTargetBearishOpen = evaluateFinalSettlementForecast({
  asset: "BTC",
  currentPrice: 99.999,
  isOpeningScenarioBot: true,
  ohlcv15m: directionalCandles(100.01, -0.0015),
  ohlcv1d: directionalCandles(100.02, -0.002),
  ohlcv1h: directionalCandles(100.01, -0.0015),
  ohlcv1m: directionalCandles(100.002, -0.001),
  ohlcv3m: directionalCandles(100.003, -0.001),
  ohlcv4h: directionalCandles(100.02, -0.002),
  ohlcv5m: directionalCandles(100.004, -0.001),
  targetPrice: 100,
  timeRemainingSeconds: 250,
});
assert.notEqual(nearTargetBearishOpen.forecast, "UNCLEAR");
assert.equal(nearTargetBearishOpen.preOpenBiasDirection, "BELOW_TARGET");
assert.equal(nearTargetBearishOpen.openingNearTargetOverrideUsed, true);

const aboveScenarios = createOpeningScenarios({
  asset: "BTC",
  candles15m: candles(),
  candles1d: candles(),
  candles1h: candles(),
  candles1m: candles(),
  candles3m: candles(),
  candles4h: candles(),
  candles5m: candles(),
  currentPrice: 99,
  expiryTime: baseMarket.expiryTime,
  finalSettlementForecast: yesBelowTarget,
  liquidityScore: 80,
  marketId: "test-market",
  noAsk: 0.65,
  openingCryptoPrice: 99,
  opportunity: yesOpportunity,
  spreadPercent: 1,
  startTime: baseMarket.startTime,
  targetPrice: 100,
  timeRemainingSeconds: 250,
  yesAsk: 0.35,
});
assert.equal(aboveScenarios.scenarios.length, 3);
assert.equal(aboveScenarios.primaryScenario.label, "ABOVE_TARGET");
assert.equal(aboveScenarios.forcedPaperPick.side, "YES");

const belowScenarios = createOpeningScenarios({
  ...aboveScenarios,
  asset: "BTC",
  candles15m: candles(),
  candles1d: candles(),
  candles1h: candles(),
  candles1m: candles(),
  candles3m: candles(),
  candles4h: candles(),
  candles5m: candles(),
  currentPrice: 101,
  expiryTime: baseMarket.expiryTime,
  finalSettlementForecast: noAboveTarget,
  liquidityScore: 80,
  marketId: "test-market-no",
  noAsk: 0.34,
  openingCryptoPrice: 101,
  opportunity: noOpportunity,
  spreadPercent: 1,
  startTime: baseMarket.startTime,
  targetPrice: 100,
  timeRemainingSeconds: 250,
  yesAsk: 0.68,
});
assert.equal(belowScenarios.primaryScenario.label, "BELOW_TARGET");
assert.equal(belowScenarios.forcedPaperPick.side, "NO");

const unclearScenarios = createOpeningScenarios({
  ...aboveScenarios,
  finalSettlementForecast: forecast({ confidence: 0.55, forecast: "ABOVE_TARGET", probabilityFinalAbove: 0.52, probabilityFinalBelow: 0.48 }),
  opportunity: opportunity(forecast({ confidence: 0.55, forecast: "ABOVE_TARGET", probabilityFinalAbove: 0.52, probabilityFinalBelow: 0.48 }), 0.48, 0.52),
});
assert.equal(unclearScenarios.primaryScenario.label, "UNCLEAR_CHOP");

const aboveTooExpensiveScenarios = createOpeningScenarios({
  ...aboveScenarios,
  finalSettlementForecast: yesBelowTarget,
  opportunity: opportunity(yesBelowTarget, 0.8, 0.2),
  yesAsk: 0.8,
  noAsk: 0.2,
});
assert.equal(aboveTooExpensiveScenarios.primaryScenario.label, "ABOVE_TARGET");
assert.equal(aboveTooExpensiveScenarios.openingDecision, "NO_TRADE_PRICE_TOO_EXPENSIVE");
assert.equal(aboveTooExpensiveScenarios.primaryScenarioKeptDespiteNoTrade, true);

const belowTooExpensiveScenarios = createOpeningScenarios({
  ...belowScenarios,
  finalSettlementForecast: noAboveTarget,
  opportunity: opportunity(noAboveTarget, 0.2, 0.8),
  yesAsk: 0.2,
  noAsk: 0.8,
});
assert.equal(belowTooExpensiveScenarios.primaryScenario.label, "BELOW_TARGET");
assert.equal(belowTooExpensiveScenarios.openingDecision, "NO_TRADE_PRICE_TOO_EXPENSIVE");
assert.equal(belowTooExpensiveScenarios.primaryScenarioKeptDespiteNoTrade, true);

const offDecision = decideOpeningEntry({
  market: baseMarket,
  opportunity: yesOpportunity,
  riskDecision: approvedRisk,
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryMode: "OFF" }),
});
assert.equal(offDecision.action, "NO_TRADE");

const ifApprovedDecision = decideOpeningEntry({
  market: baseMarket,
  opportunity: yesOpportunity,
  riskDecision: approvedRisk,
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryDelayMs: 0, entryMode: "IF_APPROVED" }),
});
assert.equal(ifApprovedDecision.action, "OPEN_STARTER_POSITION");

assert.equal(
  decideOpeningEntry({
    market: baseMarket,
    opportunity: yesOpportunity,
    riskDecision: approvedRisk,
    scenarioResult: aboveScenarios,
    settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_PAPER_ONLY" }),
  }).action,
  "FORCED_PAPER_PICK_ONLY",
);

const forcedMinStake = decideOpeningEntry({
  market: baseMarket,
  opportunity: yesOpportunity,
  riskDecision: { adjustedPositionSize: 0, approved: false, blockedBy: ["risk blocked but forced min paper"] },
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER", minStakeUsd: 1 }),
});
assert.equal(forcedMinStake.action, "OPEN_STARTER_POSITION");
assert.equal(forcedMinStake.sizeUsd, 1);
assert.equal(forcedMinStake.forcedMinStakePaperUsed, true);

const forcedWideSpread = decideOpeningEntry({
  market: { ...baseMarket, spreadPercent: 9 },
  opportunity: yesOpportunity,
  riskDecision: { adjustedPositionSize: 0, approved: false, blockedBy: ["spread too wide"] },
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER", minStakeUsd: 1 }),
});
assert.equal(forcedWideSpread.action, "OPEN_STARTER_POSITION");
assert.equal(forcedWideSpread.forcedEntryDespiteWideSpread, true);

const lateForcedMinStake = decideOpeningEntry({
  market: { ...baseMarket, startTime: Date.now() - 45_000, timeRemainingSeconds: 255 },
  opportunity: yesOpportunity,
  riskDecision: { adjustedPositionSize: 0, approved: false, blockedBy: ["opening data was late"] },
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER", entryWindowSeconds: 12, minStakeUsd: 1 }),
});
assert.equal(lateForcedMinStake.action, "OPEN_STARTER_POSITION");
assert.equal(lateForcedMinStake.lateForcedEntryUsed, true);

const tooLateForcedMinStake = decideOpeningEntry({
  market: { ...baseMarket, startTime: Date.now() - 260_000, timeRemainingSeconds: 40 },
  opportunity: yesOpportunity,
  riskDecision: { adjustedPositionSize: 0, approved: false, blockedBy: ["opening data was late"] },
  scenarioResult: aboveScenarios,
  settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER", entryWindowSeconds: 12, minStakeUsd: 1 }),
});
assert.equal(tooLateForcedMinStake.action, "NO_TRADE");
assert.ok(tooLateForcedMinStake.reasonCodes.includes("OPENING_ENTRY_WINDOW_EXPIRED"));

assert.equal(
  decideOpeningEntry({
    market: { ...baseMarket, targetPrice: 0 },
    opportunity: yesOpportunity,
    riskDecision: approvedRisk,
    scenarioResult: aboveScenarios,
    settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER" }),
  }).action,
  "NO_TRADE",
);

assert.equal(
  decideOpeningEntry({
    market: { ...baseMarket, yesAsk: null },
    opportunity: yesOpportunity,
    riskDecision: approvedRisk,
    scenarioResult: aboveScenarios,
    settings: openingSettings({ entryDelayMs: 0, entryMode: "FORCED_MIN_STAKE_PAPER" }),
  }).action,
  "NO_TRADE",
);

const paperPosition: PaperPosition = {
  addCount: 0,
  entrySizeUsd: 1,
  entryTokenPrice: 0.5,
  marketId: "test-market",
  side: "YES",
};
const valueAdd = evaluateSmartScaling({
  currentForecast: yesBelowTarget,
  currentNoAsk: 0.65,
  currentOpportunity: yesOpportunity,
  currentPrice: 99,
  currentYesAsk: 0.4,
  position: paperPosition,
  targetPrice: 100,
  timeRemainingSeconds: 180,
});
assert.equal(valueAdd.action, "VALUE_ADD_APPROVED");

assert.equal(
  evaluateSmartScaling({
    currentForecast: unclear,
    currentNoAsk: 0.5,
    currentOpportunity: unclearOpportunity,
    currentPrice: 100,
    currentYesAsk: 0.5,
    position: paperPosition,
    targetPrice: 100,
    timeRemainingSeconds: 180,
  }).action,
  "ADD_BLOCKED_SCENARIO_WEAKENED",
);

assert.equal(
  evaluateSmartScaling({
    currentForecast: noAboveTarget,
    currentNoAsk: 0.35,
    currentOpportunity: noOpportunity,
    currentPrice: 101,
    currentYesAsk: 0.65,
    position: paperPosition,
    targetPrice: 100,
    timeRemainingSeconds: 180,
  }).action,
  "ADD_BLOCKED_SCENARIO_WEAKENED",
);

assert.equal(
  evaluateDeRisk({
    currentTokenPrice: 0.4,
    forecast: noAboveTarget,
    opportunity: noOpportunity,
    position: paperPosition,
    timeRemainingSeconds: 120,
  }).action,
  "EXIT_OPPOSITE_FORECAST",
);

assert.equal(
  evaluateDeRisk({
    currentTokenPrice: 0.8,
    forecast: yesBelowTarget,
    opportunity: yesOpportunity,
    position: paperPosition,
    timeRemainingSeconds: 120,
  }).action,
  "TAKE_PARTIAL_PROFIT",
);

console.log("BLACK-GOAT V3 engine tests OK");
