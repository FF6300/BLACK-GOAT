import { BLACK_GOAT_V3_CONFIG } from "./v3Config";
import type { Crypto5mMarket, CryptoAsset, ParsedTarget, RawPolymarketMarket } from "./types";

const seenMarkets = new Set<string>();

export async function scanActiveCrypto5mMarkets(fetchImpl: typeof fetch = fetch): Promise<Crypto5mMarket[]> {
  const response = await fetchImpl("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100");
  const raw = (await response.json()) as RawPolymarketMarket[];
  const now = Date.now();
  return raw
    .map((market) => normalizeCrypto5mMarket(market, now))
    .filter((market): market is Crypto5mMarket => market !== null);
}

export function parseMarketTarget(market: RawPolymarketMarket): ParsedTarget {
  if (typeof market.priceToBeat === "number" && Number.isFinite(market.priceToBeat)) {
    return { source: "market_priceToBeat", targetPrice: market.priceToBeat };
  }
  const text = `${market.question ?? ""} ${market.description ?? ""}`;
  const match = text.match(/(?:price to beat|target|opening price)[^\d$-]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (match?.[1] !== undefined) {
    const target = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(target)) {
      return { source: "text", targetPrice: target };
    }
  }
  return { source: "unavailable", targetPrice: null };
}

export function isNewMarketOpen(marketId: string): boolean {
  if (seenMarkets.has(marketId)) {
    return false;
  }
  seenMarkets.add(marketId);
  return true;
}

function normalizeCrypto5mMarket(market: RawPolymarketMarket, now: number): Crypto5mMarket | null {
  const asset = inferAsset(market);
  if (asset === null || !BLACK_GOAT_V3_CONFIG.marketScanner.allowedAssets.includes(asset)) return null;
  const parsedTarget = parseMarketTarget(market);
  if (parsedTarget.targetPrice === null && BLACK_GOAT_V3_CONFIG.marketScanner.ignoreMarketIfTargetMissing) return null;
  const startTime = market.eventStartTime === null || market.eventStartTime === undefined ? NaN : Date.parse(market.eventStartTime);
  const expiryTime = market.endDate === null || market.endDate === undefined ? NaN : Date.parse(market.endDate);
  if (!Number.isFinite(expiryTime) && BLACK_GOAT_V3_CONFIG.marketScanner.ignoreMarketIfExpiryMissing) return null;
  const outcomes = market.outcomes ?? [];
  const upIndex = outcomes.findIndex((outcome) => outcome.toLowerCase().includes("up"));
  const yesIndex = upIndex >= 0 ? upIndex : 0;
  const noIndex = yesIndex === 0 ? 1 : 0;
  const yesAsk = readNumber(market.outcomePrices?.[yesIndex]) ?? market.bestAsk ?? null;
  const noAsk = readNumber(market.outcomePrices?.[noIndex]) ?? (yesAsk === null ? null : 1 - yesAsk);
  const yesBid = market.bestBid ?? (yesAsk === null ? null : Math.max(0.01, yesAsk - 0.01));
  const noBid = noAsk === null ? null : Math.max(0.01, noAsk - 0.01);

  return {
    asset,
    expiryTime,
    liquidityScore: calculateLiquidityScore(market.liquidity ?? null),
    marketId: market.id ?? market.slug ?? market.question ?? `${asset}-${expiryTime}`,
    noAsk,
    noBid,
    noTokenId: market.clobTokenIds?.[noIndex] ?? "",
    question: market.question ?? `${asset} Up or Down 5m`,
    rules: market.description ?? undefined,
    spreadPercent: yesBid === null || yesAsk === null ? null : ((yesAsk - yesBid) / Math.max(yesAsk, 0.01)) * 100,
    startTime,
    targetPrice: parsedTarget.targetPrice ?? 0,
    timeRemainingSeconds: Math.max(0, Math.floor((expiryTime - now) / 1_000)),
    yesAsk,
    yesBid,
    yesTokenId: market.clobTokenIds?.[yesIndex] ?? "",
  };
}

function inferAsset(market: RawPolymarketMarket): CryptoAsset | null {
  const text = `${market.question ?? ""} ${market.slug ?? ""}`.toLowerCase();
  if (text.includes("bitcoin") || text.includes("btc")) return "BTC";
  if (text.includes("ethereum") || text.includes("eth")) return "ETH";
  if (text.includes("solana") || text.includes("sol")) return "SOL";
  if (text.includes("xrp") || text.includes("ripple")) return "XRP";
  if (text.includes("doge")) return "DOGE";
  if (text.includes("bnb")) return "BNB";
  if (text.includes("hype") || text.includes("hyperliquid")) return "HYPE";
  return null;
}

function readNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateLiquidityScore(liquidity: number | null) {
  if (liquidity === null || !Number.isFinite(liquidity)) return 50;
  return Math.max(10, Math.min(100, Math.round(Math.log10(Math.max(10, liquidity)) * 22)));
}
