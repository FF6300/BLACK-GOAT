import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { Candle, FinalSettlementForecast, FinalSettlementInput } from "./types";

export function evaluateFinalSettlementForecast(input: FinalSettlementInput): FinalSettlementForecast {
  const distanceToTargetUsd = input.currentPrice - input.targetPrice;
  const distanceToTargetPercent = (distanceToTargetUsd / Math.max(input.targetPrice, 1)) * 100;
  const distanceToTargetBps = distanceToTargetPercent * 100;
  const currentPositionRelativeToTarget =
    Math.abs(distanceToTargetBps) <= BLACK_GOAT_V3_CONFIG.finalSettlementEngine.nearTargetBps
      ? "NEAR"
      : distanceToTargetUsd > 0
        ? "ABOVE"
        : "BELOW";
  const oneMinuteMomentum = calculateMomentum(input.ohlcv1m);
  const fiveMinuteMomentum = calculateMomentum(input.ohlcv5m);
  const shortMomentum = weightedAverage([
    [oneMinuteMomentum, 0.45],
    [calculateMomentum(input.ohlcv3m ?? input.ohlcv1m), 0.25],
    [fiveMinuteMomentum, 0.3],
  ]);
  const trendAlignmentScore = calculateTrendAlignmentScore(input);
  const momentumDirection = shortMomentum > 0.00012 ? "UP" : shortMomentum < -0.00012 ? "DOWN" : "NEUTRAL";
  const momentumStrength = Math.max(0, Math.min(100, Math.round(Math.abs(shortMomentum) * 25_000)));
  const distanceSignal = Math.max(-0.16, Math.min(0.16, distanceToTargetBps / 160));
  const trendSignal = (trendAlignmentScore - 50) / 250;
  const momentumSignal = Math.max(-0.18, Math.min(0.18, shortMomentum * 180));
  const timePressure = Math.max(0, Math.min(1, 1 - input.timeRemainingSeconds / 300));
  const reversalScore = calculateReversalScore({ distanceToTargetBps, momentumDirection, trendAlignmentScore });
  const continuationScore = Math.max(0, Math.min(100, Math.round(50 + trendSignal * 130 + momentumSignal * 160 - reversalScore * 0.15)));
  const preOpenBias = calculatePreOpenBias(input);
  const isOpeningWindow = input.isOpeningScenarioBot === true && input.timeRemainingSeconds > BLACK_GOAT_V3_CONFIG.starterEntry.minTimeRemainingSeconds;
  let probabilityFinalAbove = clamp01(0.5 + distanceSignal * (0.38 + timePressure * 0.28) + trendSignal + momentumSignal);
  const reasonCodes: string[] = [];
  let openingNearTargetOverrideUsed = false;

  if (currentPositionRelativeToTarget === "NEAR" && momentumDirection === "NEUTRAL") {
    if (
      isOpeningWindow &&
      BLACK_GOAT_V3_CONFIG.openingScenarioBot.nearTargetAtOpenIsAllowed &&
      BLACK_GOAT_V3_CONFIG.openingScenarioBot.doNotForceUnclearBecauseNearTargetAtOpen &&
      BLACK_GOAT_V3_CONFIG.openingScenarioBot.usePreOpenBiasWhenNearTarget &&
      preOpenBias.direction !== "NEUTRAL"
    ) {
      openingNearTargetOverrideUsed = true;
      probabilityFinalAbove = clamp01(0.5 + (preOpenBias.score / 100) * 0.22);
      reasonCodes.push("OPENING_NEAR_TARGET_OVERRIDE_USED", `PRE_OPEN_BIAS_${preOpenBias.direction}`);
    } else {
      probabilityFinalAbove = 0.5;
      reasonCodes.push("NEAR_TARGET_WITH_NEUTRAL_MOMENTUM");
    }
  }
  if (input.marketRegime === "high_volatility") {
    probabilityFinalAbove = 0.5 + (probabilityFinalAbove - 0.5) * 0.72;
    reasonCodes.push("HIGH_VOLATILITY_REDUCED_CONFIDENCE");
  }
  if ((momentumDirection === "UP" && trendAlignmentScore < 44) || (momentumDirection === "DOWN" && trendAlignmentScore > 56)) {
    probabilityFinalAbove = 0.5 + (probabilityFinalAbove - 0.5) * 0.62;
    reasonCodes.push("CONTRADICTORY_TIMEFRAMES");
  }

  const probabilityFinalBelow = clamp01(1 - probabilityFinalAbove);
  const edgeFromCoinflip = Math.abs(probabilityFinalAbove - 0.5);
  const confidence = clamp01(
    0.42 +
      edgeFromCoinflip * 1.35 +
      Math.min(0.2, momentumStrength / 500) +
      Math.min(0.14, Math.abs(trendAlignmentScore - 50) / 260) +
      (openingNearTargetOverrideUsed ? Math.min(0.2, Math.abs(preOpenBias.score) / 250) : 0),
  );
  const forecast =
    reasonCodes.includes("CONTRADICTORY_TIMEFRAMES") ||
    (currentPositionRelativeToTarget === "NEAR" && momentumDirection === "NEUTRAL" && !openingNearTargetOverrideUsed) ||
    (confidence < 0.53 && !openingNearTargetOverrideUsed)
      ? "UNCLEAR"
      : probabilityFinalAbove > probabilityFinalBelow
        ? "ABOVE_TARGET"
        : "BELOW_TARGET";

  if (forecast === "ABOVE_TARGET") reasonCodes.push("FORECAST_FINAL_ABOVE_TARGET");
  if (forecast === "BELOW_TARGET") reasonCodes.push("FORECAST_FINAL_BELOW_TARGET");
  if (forecast === "UNCLEAR") reasonCodes.push("FORECAST_UNCLEAR");

  return {
    confidence,
    continuationScore,
    currentPositionRelativeToTarget,
    distanceToTargetBps,
    distanceToTargetPercent,
    distanceToTargetUsd,
    explanation: buildForecastExplanation(forecast, probabilityFinalAbove, distanceToTargetBps, momentumDirection, trendAlignmentScore),
    forecast,
    momentumDirection,
    momentumStrength,
    openingNearTargetOverrideUsed,
    preOpenBiasDirection: preOpenBias.direction,
    preOpenBiasScore: preOpenBias.score,
    probabilityFinalAbove,
    probabilityFinalBelow,
    reasonCodes,
    reversalScore,
    trendAlignmentScore,
  };
}

function calculateTrendAlignmentScore(input: FinalSettlementInput) {
  const weighted = weightedAverage([
    [trendScore(input.ohlcv1M ?? input.ohlcv1d), 0.04],
    [trendScore(input.ohlcv1w ?? input.ohlcv1d), 0.07],
    [trendScore(input.ohlcv1d), 0.12],
    [trendScore(input.ohlcv4h), 0.14],
    [trendScore(input.ohlcv1h), 0.18],
    [trendScore(input.ohlcv15m), 0.18],
    [trendScore(input.ohlcv5m), 0.16],
    [trendScore(input.ohlcv3m ?? input.ohlcv1m), 0.09],
    [trendScore(input.ohlcv1m), 0.08],
  ]);
  return Math.max(0, Math.min(100, Math.round(50 + weighted * 50)));
}

function trendScore(candles: Candle[]) {
  if (candles.length < 2) return 0;
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (first === undefined || last === undefined || first.close <= 0) return 0;
  const change = (last.close - first.close) / first.close;
  const emaFast = ema(candles.map((candle) => candle.close), Math.min(5, candles.length));
  const emaSlow = ema(candles.map((candle) => candle.close), Math.min(12, candles.length));
  return Math.max(-1, Math.min(1, change * 85 + (emaFast - emaSlow) / Math.max(last.close, 1) * 120));
}

function calculateMomentum(candles: Candle[]) {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1];
  const previous = candles[Math.max(0, candles.length - 4)];
  if (last === undefined || previous === undefined || previous.close <= 0) return 0;
  return (last.close - previous.close) / previous.close;
}

function calculateReversalScore({
  distanceToTargetBps,
  momentumDirection,
  trendAlignmentScore,
}: {
  distanceToTargetBps: number;
  momentumDirection: "UP" | "DOWN" | "NEUTRAL";
  trendAlignmentScore: number;
}) {
  const stretched = Math.min(45, Math.abs(distanceToTargetBps) / 2);
  const againstTrend = (distanceToTargetBps > 0 && trendAlignmentScore < 45) || (distanceToTargetBps < 0 && trendAlignmentScore > 55) ? 25 : 0;
  const momentumAgainst = (distanceToTargetBps > 0 && momentumDirection === "DOWN") || (distanceToTargetBps < 0 && momentumDirection === "UP") ? 20 : 0;
  return Math.max(0, Math.min(100, Math.round(25 + stretched + againstTrend + momentumAgainst)));
}

function calculatePreOpenBias(input: FinalSettlementInput) {
  const closes = [
    ...input.ohlcv5m.map((candle) => candle.close),
    ...(input.ohlcv3m ?? []).map((candle) => candle.close),
    ...input.ohlcv1m.map((candle) => candle.close),
  ].filter((value): value is number => Number.isFinite(value));
  const lastClose = closes[closes.length - 1] ?? input.currentPrice;
  const momentum1m = calculateMomentum(input.ohlcv1m);
  const momentum3m = calculateMomentum(input.ohlcv3m ?? input.ohlcv1m);
  const momentum5m = calculateMomentum(input.ohlcv5m);
  const lastCandle = input.ohlcv1m[input.ohlcv1m.length - 1];
  const previousCandles = input.ohlcv1m.slice(0, -1);
  const candleBody =
    lastCandle === undefined || lastCandle.open <= 0 ? 0 : Math.max(-1, Math.min(1, ((lastCandle.close - lastCandle.open) / lastCandle.open) * 2_500));
  const recentHigh = Math.max(...previousCandles.map((candle) => candle.high), lastClose);
  const recentLow = Math.min(...previousCandles.map((candle) => candle.low), lastClose);
  const breakoutSignal =
    lastClose > recentHigh ? 0.28 : lastClose < recentLow ? -0.28 : recentHigh > recentLow ? ((lastClose - recentLow) / (recentHigh - recentLow) - 0.5) * 0.24 : 0;
  const volumeValues = input.ohlcv1m.map((candle) => candle.volume ?? 0).filter((volume) => volume > 0);
  const latestVolume = volumeValues[volumeValues.length - 1] ?? 0;
  const averageVolume = volumeValues.length === 0 ? 0 : volumeValues.reduce((sum, volume) => sum + volume, 0) / volumeValues.length;
  const volumeSignal = averageVolume > 0 ? Math.max(-0.12, Math.min(0.12, (latestVolume / averageVolume - 1) * 0.08)) : 0;
  const vwap = input.volumeProfile?.vwap ?? average(closes) ?? lastClose;
  const vwapSignal = lastClose <= 0 ? 0 : Math.max(-0.24, Math.min(0.24, ((lastClose - vwap) / lastClose) * 1_600));
  const emaFast = ema(closes, Math.min(5, closes.length));
  const emaSlow = ema(closes, Math.min(12, closes.length));
  const emaSignal = lastClose <= 0 ? 0 : Math.max(-0.18, Math.min(0.18, ((emaFast - emaSlow) / lastClose) * 1_400));
  const signed =
    momentum1m * 2_200 * 0.24 +
    momentum3m * 1_650 * 0.2 +
    momentum5m * 1_200 * 0.18 +
    candleBody * 0.13 +
    breakoutSignal +
    volumeSignal +
    vwapSignal * 0.14 +
    emaSignal * 0.11;
  const score = Math.max(-100, Math.min(100, Math.round(signed * 100)));
  const direction = score >= 8 ? "ABOVE_TARGET" : score <= -8 ? "BELOW_TARGET" : "NEUTRAL";
  return { direction, score } as const;
}

function buildForecastExplanation(forecast: string, probabilityAbove: number, distanceBps: number, momentum: string, alignment: number) {
  return `${forecast}: final above ${(probabilityAbove * 100).toFixed(1)}%, distance ${distanceBps.toFixed(1)} bps, momentum ${momentum}, alignment ${alignment}/100.`;
}

function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  return values.reduce((acc, value, index) => (index === 0 ? value : value * k + acc * (1 - k)), values[0] ?? 0);
}

function weightedAverage(values: Array<[number, number]>) {
  const totalWeight = values.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  return values.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number) {
  return Math.max(0.01, Math.min(0.99, value));
}
