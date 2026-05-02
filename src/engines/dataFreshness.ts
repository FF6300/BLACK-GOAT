import { BLACK_GOAT_V3_CONFIG } from "./v3Config";

export type DataFreshnessInput = {
  cryptoPriceAgeMs: number | null;
  polymarketBookAgeMs: number | null;
  forecastAgeMs: number | null;
};

export type DataFreshnessResult = {
  fresh: boolean;
  blockedBy: string[];
};

export function evaluateDataFreshness(input: DataFreshnessInput): DataFreshnessResult {
  const cfg = BLACK_GOAT_V3_CONFIG.dataFreshness;
  const blockedBy: string[] = [];

  if (cfg.blockIfCriticalDataStale && input.cryptoPriceAgeMs !== null && input.cryptoPriceAgeMs > cfg.maxCryptoPriceAgeMs) {
    blockedBy.push("STALE_CRYPTO_PRICE");
  }
  if (cfg.blockIfCriticalDataStale && input.polymarketBookAgeMs !== null && input.polymarketBookAgeMs > cfg.maxPolymarketBookAgeMs) {
    blockedBy.push("STALE_POLYMARKET_BOOK");
  }
  if (cfg.blockIfCriticalDataStale && input.forecastAgeMs !== null && input.forecastAgeMs > cfg.maxForecastAgeMs) {
    blockedBy.push("STALE_FORECAST");
  }

  return {
    blockedBy,
    fresh: blockedBy.length === 0,
  };
}
