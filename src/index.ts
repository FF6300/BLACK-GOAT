import "dotenv/config";

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { DEFAULT_OPENING_SCENARIO_SETTINGS } from "./engines/v3Config.js";
import type { OpeningEntryMode, OpeningScenarioSettings } from "./engines/types.js";

const APP_NAME = "BLACK-GOAT";
const MODE = (process.env.MODE ?? "TEST").toUpperCase();
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = readNumberEnv("PORT", 4000);
const POLYMARKET_MARKET_LIMIT = readNumberEnv("POLYMARKET_MARKET_LIMIT", 10);
const POLYMARKET_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com",
);
const POLYMARKET_DATA_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_DATA_API_BASE ?? "https://data-api.polymarket.com",
);
const POLYMARKET_CLOB_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_CLOB_API_BASE ?? "https://clob.polymarket.com",
);
const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLYMARKET_RTDS_WS_URL = process.env.POLYMARKET_RTDS_WS_URL ?? "wss://ws-live-data.polymarket.com";
const POLYMARKET_REQUEST_TIMEOUT_MS = readNumberEnv("POLYMARKET_REQUEST_TIMEOUT_MS", 10_000);
const POLYMARKET_WS_TIMEOUT_MS = readNumberEnv("POLYMARKET_WS_TIMEOUT_MS", 10_000);
const POLYMARKET_TRADES_FETCH_LIMIT = readNumberEnv("POLYMARKET_TRADES_FETCH_LIMIT", 500);
const POLYMARKET_TRADES_POLL_MS = readNumberEnv("POLYMARKET_TRADES_POLL_MS", 5_000);
const CLIENT_WS_PATH = "/ws/polymarket";
const CRYPTO_PRICES_WS_PATH = "/ws/crypto-prices";
const TRADERS_WS_PATH = "/ws/traders";
const MAX_WS_ASSET_IDS = 80;
const DATA_SOURCE_REAL = "REAL POLYMARKET DATA";
const DATA_SOURCE_UNAVAILABLE = "UNAVAILABLE";
const FEATURED_UPDOWN_SYMBOLS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"] as const;
const FEATURED_UPDOWN_LOOKBACK_WINDOWS = 1;
const FEATURED_UPDOWN_LOOKAHEAD_WINDOWS = 4;
const CRYPTO_PRICE_HISTORY_LIMIT = 900;
const cryptoPriceHistory = new Map<string, Array<{ price: number; timestamp: number }>>();
let openingScenarioSettings: OpeningScenarioSettings = { ...DEFAULT_OPENING_SCENARIO_SETTINGS };

const PERIOD_SECONDS = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

const TOP_TRADER_PERIOD_SECONDS = {
  "10m": 10 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
} as const;

function safeCloseWebSocket(ws: WebSocket) {
  ws.on("error", () => undefined);

  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      ws.close();
      return;
    }

    ws.terminate();
  } catch {
    // Closing a socket during the handshake can throw in ws; the caller is already tearing it down.
  }
}

if (MODE !== "TEST") {
  throw new Error("BLACK-GOAT only supports MODE=TEST for this read-only viewer.");
}

type GammaMarket = {
  id?: string | number;
  question?: string;
  slug?: string;
  image?: string;
  icon?: string;
  description?: string;
  startDate?: string;
  outcomes?: unknown;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
  volume?: string | number;
  volume24hr?: string | number;
  liquidity?: string | number;
  liquidityNum?: string | number;
  endDate?: string;
  eventStartTime?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  lastTradePrice?: string | number;
  bestBid?: string | number;
  bestAsk?: string | number;
  oneHourPriceChange?: string | number;
  priceToBeat?: unknown;
  finalPrice?: unknown;
  sourceType?: "CURATED_LIVE_CRYPTO" | "GAMMA_VOLUME";
};

type PublicMarket = {
  id: string | null;
  question: string | null;
  slug: string | null;
  image: string | null;
  icon: string | null;
  description: string | null;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  volume24hr: number | null;
  liquidity: number | null;
  startDate: string | null;
  endDate: string | null;
  eventStartTime: string | null;
  active: boolean | null;
  closed: boolean | null;
  acceptingOrders: boolean | null;
  lastTradePrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  oneHourPriceChange: number | null;
  priceToBeat: number | null;
  finalPrice: number | null;
  sourceType: "CURATED_LIVE_CRYPTO" | "GAMMA_VOLUME";
};

type GammaEvent = {
  title?: string;
  slug?: string;
  image?: string;
  icon?: string;
  description?: string;
  resolutionSource?: string;
  startTime?: string;
  endDate?: string;
  eventMetadata?: {
    priceToBeat?: unknown;
    finalPrice?: unknown;
  };
  markets?: GammaMarket[];
};

type FetchJsonResult<T> = {
  data: T;
  endpoint: string;
  latencyMs: number;
  status: number;
  stale?: boolean;
};

type CacheEntry<T> = {
  storedAt: number;
  value: T;
};

type PeriodKey = keyof typeof PERIOD_SECONDS;
type DataSourceStatus = typeof DATA_SOURCE_REAL | typeof DATA_SOURCE_UNAVAILABLE;
type TraderSort =
  | "profile_quality"
  | "indicative_score"
  | "activity"
  | "volume"
  | "consistency"
  | "risk"
  | "last_activity"
  | "trades"
  | "average_placement";
type TopTraderPeriod = keyof typeof TOP_TRADER_PERIOD_SECONDS | "day" | "week" | "all";
type TopTraderSort = "globalScore" | "pnl" | "volume" | "activity";
type LeaderboardTimePeriod = "DAY" | "WEEK" | "ALL";

type ClientMessage = {
  type?: unknown;
  assetIds?: unknown;
  assets_ids?: unknown;
  chainlinkSymbol?: unknown;
  fallbackSymbol?: unknown;
};

type LivePriceUpdate = {
  type: "price";
  assetId: string;
  eventType: string;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  side: string | null;
  market: string | null;
  upstreamTimestamp: number | null;
  latencyMs: number | null;
  time: string;
};

type LiveCryptoPriceUpdate = {
  type: "crypto_price";
  source: "chainlink" | "binance";
  symbol: string;
  price: number;
  upstreamTimestamp: number | null;
  latencyMs: number | null;
  time: string;
};

type MarketLifecycleUpdate = {
  type: "market_event";
  eventType: string;
  market: string | null;
  conditionId: string | null;
  time: string;
  upstreamTimestamp: number | null;
};

type DataApiTrade = {
  proxyWallet?: unknown;
  side?: unknown;
  asset?: unknown;
  conditionId?: unknown;
  size?: unknown;
  price?: unknown;
  timestamp?: unknown;
  title?: unknown;
  slug?: unknown;
  icon?: unknown;
  eventSlug?: unknown;
  outcome?: unknown;
  outcomeIndex?: unknown;
  name?: unknown;
  pseudonym?: unknown;
  bio?: unknown;
  profileImage?: unknown;
  profileImageOptimized?: unknown;
  transactionHash?: unknown;
};

type LeaderboardEntry = {
  rank?: unknown;
  proxyWallet?: unknown;
  userName?: unknown;
  name?: unknown;
  pseudonym?: unknown;
  vol?: unknown;
  volume?: unknown;
  pnl?: unknown;
  profileImage?: unknown;
};

type PublicProfile = {
  createdAt?: unknown;
  proxyWallet?: unknown;
  profileImage?: unknown;
  displayUsernamePublic?: unknown;
  bio?: unknown;
  pseudonym?: unknown;
  name?: unknown;
  xUsername?: unknown;
  verifiedBadge?: unknown;
};

type NormalizedTrade = {
  id: string;
  wallet: string | null;
  trader: string | null;
  username: string | null;
  pseudonym: string | null;
  side: string | null;
  asset: string | null;
  conditionId: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  size: number | null;
  price: number | null;
  amount: number | null;
  amountSource: "DERIVED_FROM_REAL_SIZE_PRICE" | typeof DATA_SOURCE_UNAVAILABLE;
  timestamp: number | null;
  time: string | null;
  transactionHash: string | null;
  profileImage: string | null;
  profileUrl: string | null;
  marketUrl: string | null;
  dataSourceStatus: DataSourceStatus;
};

type TraderScores = {
  indicativeScore: number | null;
  activityScore: number | null;
  volumeScore: number | null;
  consistencyScore: number | null;
  riskScore: number;
  riskLabel: "Très faible" | "Faible" | "Modéré" | "Élevé" | "Très élevé";
  riskFactors: string[];
  overallScore: number | null;
  disclaimer: string;
};

type ActiveTrader = {
  id: string;
  wallet: string;
  username: string | null;
  pseudonym: string | null;
  volumeRecent: number;
  tradesRecent: number;
  lastActivity: string | null;
  market: string | null;
  outcome: string | null;
  price: number | null;
  amount: number | null;
  averagePlacement: number | null;
  profileUrl: string;
  dataSourceStatus: DataSourceStatus;
  scores: TraderScores;
};

type TopTraderScores = {
  globalScore: number;
  riskScore: number;
  activityScore: number;
  volumeScore: number;
  consistencyScore: number;
};

type TopTrader = {
  rank: number;
  wallet: string;
  username: string | null;
  profileImage: string | null;
  profileUrl: string;
  mainMarket: string;
  volume: number;
  pnl: number | null;
  trades: number;
  averagePlacement: number;
  marketsCount: number;
  lastActivity: string | null;
  scores: TopTraderScores;
  dataSourceStatus: DataSourceStatus;
};

const app = express();
const server = createServer(app);
const clientWss = new WebSocketServer({ noServer: true });
const cryptoPricesWss = new WebSocketServer({ noServer: true });
const tradersWss = new WebSocketServer({ noServer: true });
const marketsCache = new Map<number, CacheEntry<FetchJsonResult<GammaMarket[]>>>();
const topTradersCache = new Map<string, CacheEntry<{ source: string; traders: TopTrader[] }>>();
const POLYMARKET_CACHE_TTL_MS = readNumberEnv("POLYMARKET_CACHE_TTL_MS", 15_000);
const POLYMARKET_STALE_TTL_MS = readNumberEnv("POLYMARKET_STALE_TTL_MS", 120_000);

app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    appName: APP_NAME,
    mode: MODE,
    host: HOST,
    port: PORT,
    time: new Date().toISOString(),
  });
});

app.get("/api/bots/opening-scenario/settings", (_req, res) => {
  res.json(openingScenarioSettings);
});

app.put("/api/bots/opening-scenario/settings", (req, res) => {
  const parsed = parseOpeningScenarioSettings(req.body);
  if (!parsed.ok) {
    res.status(400).json({
      ok: false,
      appName: APP_NAME,
      mode: MODE,
      error: parsed.error,
      time: new Date().toISOString(),
    });
    return;
  }

  openingScenarioSettings = parsed.settings;
  res.json(openingScenarioSettings);
});

app.get("/api/polymarket/status", async (_req, res) => {
  try {
    const result = await fetchPolymarketMarketsCached(1);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      api: "Polymarket Gamma",
      endpoint: result.endpoint,
      status: result.status,
      latencyMs: result.latencyMs,
      marketCount: result.data.length,
      stale: result.stale ?? false,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket public API request failed.", error);
  }
});

app.get("/api/polymarket/markets", async (req, res) => {
  try {
    const limit = readLimit(req.query.limit, POLYMARKET_MARKET_LIMIT);
    const result = await fetchPolymarketMarketsCached(limit);
    const markets = result.data.map(normalizeMarket);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      endpoint: result.endpoint,
      count: markets.length,
      markets,
      stale: result.stale ?? false,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket markets request failed.", error);
  }
});

app.get("/api/polymarket/crypto-prices/history", (req, res) => {
  try {
    const symbol = readCryptoSymbol(req.query.symbol, "btc/usd");
    const nowMs = Date.now();
    const startMs = parseTimestamp(req.query.startTs) ?? nowMs - 5 * 60_000;
    const endMs = parseTimestamp(req.query.endTs) ?? nowMs;
    const limit = readLimit(req.query.limit, 600, CRYPTO_PRICE_HISTORY_LIMIT);
    const points = (cryptoPriceHistory.get(symbol) ?? [])
      .filter((point) => point.timestamp >= startMs && point.timestamp <= endMs)
      .slice(-limit);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: points.length > 0 ? DATA_SOURCE_REAL : DATA_SOURCE_UNAVAILABLE,
      symbol,
      count: points.length,
      points,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket RTDS crypto history request failed.", error);
  }
});

app.get("/api/polymarket/ws-test", async (_req, res) => {
  try {
    const marketResult = await fetchPolymarketMarketsCached(1);
    const market = marketResult.data.map(normalizeMarket).find((item) => item.clobTokenIds.length > 0);
    const assetIds = market?.clobTokenIds.slice(0, 2) ?? [];

    if (assetIds.length === 0) {
      throw new Error("No CLOB token IDs found in the public markets response.");
    }

    const result = await testPolymarketWebSocket(assetIds);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      endpoint: POLYMARKET_WS_URL,
      subscribedAssetIds: assetIds,
      connected: result.connected,
      subscribed: result.subscribed,
      messageReceived: result.messageReceived,
      firstMessageType: result.firstMessageType,
      latencyMs: result.latencyMs,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket WebSocket test failed.", error);
  }
});

app.get("/api/polymarket/traders/active", async (req, res) => {
  try {
    const period = readPeriod(req.query.period);
    const sort = readTraderSort(req.query.sort);
    const search = readQueryString(req.query.search);
    const minVolume = readMinimumNumber(req.query.minVolume);
    const minTrades = readMinimumNumber(req.query.minTrades);
    const limit = readLimit(req.query.limit, 50, 100);
    const result = await fetchDataApiTrades(POLYMARKET_TRADES_FETCH_LIMIT);
    const trades = filterTradesByPeriod(result.data.map(normalizeTrade), period);
    const traders = buildActiveTraders(trades, {
      minTrades,
      minVolume,
      search,
      sort,
    }).slice(0, limit);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: DATA_SOURCE_REAL,
      source: result.endpoint,
      period,
      filters: {
        search,
        minVolume,
        minTrades,
        sort,
      },
      count: traders.length,
      traders,
      limitations: [
        "Active traders are derived from the public Polymarket Data API /trades response.",
        "Fields not returned by Polymarket are null or unavailable.",
        "Scores are read-only analytical indicators, not financial advice.",
      ],
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket active traders request failed.", error);
  }
});

app.get("/api/polymarket/traders/:id", async (req, res) => {
  try {
    const wallet = req.params.id;
    if (!isWalletAddress(wallet)) {
      res.status(400).json({
        ok: false,
        appName: APP_NAME,
        mode: MODE,
        message: "Trader id must be a 0x wallet address.",
        dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
        time: new Date().toISOString(),
      });
      return;
    }

    const period = readPeriod(req.query.period, "24h");
    const [tradesResult, profileResult] = await Promise.all([
      fetchDataApiTrades(readLimit(req.query.limit, 200, 500), wallet),
      fetchPublicProfile(wallet),
    ]);
    const allTrades = tradesResult.data.map(normalizeTrade);
    const recentTrades = filterTradesByPeriod(allTrades, period);
    const profile = normalizeProfile(profileResult.profile, wallet);
    const volumeRecent = sumTradeVolume(recentTrades);
    const averagePlacement = calculateAveragePlacement(volumeRecent, recentTrades.length);
    const marketsMostTraded = buildMostTradedMarkets(recentTrades);
    const outcomesTraded = buildOutcomesTraded(recentTrades);
    const lastTrade = recentTrades[0] ?? null;
    const fallbackTrade = lastTrade ?? allTrades[0] ?? null;
    const dataInsufficient = allTrades.length === 0;

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: dataInsufficient ? DATA_SOURCE_UNAVAILABLE : DATA_SOURCE_REAL,
      profileDataSourceStatus: profileResult.dataSourceStatus,
      trader: {
        wallet,
        username: profile.username ?? fallbackTrade?.username ?? null,
        pseudonym: profile.pseudonym ?? fallbackTrade?.pseudonym ?? null,
        bio: profile.bio,
        profileImage: profile.profileImage,
        xUsername: profile.xUsername,
        verifiedBadge: profile.verifiedBadge,
        createdAt: profile.createdAt,
        profileUrl: buildProfileUrl(wallet),
      },
      summary: dataInsufficient
        ? {
            message: "Donnees insuffisantes",
            volumeRecent: null,
            averagePlacement: null,
            tradesRecent: 0,
            lastActivity: null,
            activityRecent: null,
            scores: emptyScores(),
          }
        : {
            message: null,
            period,
            volumeRecent,
            averagePlacement,
            tradesRecent: recentTrades.length,
            lastActivity: lastTrade?.time ?? null,
            activityRecent: recentTrades.length > 0 ? "REAL POLYMARKET DATA" : DATA_SOURCE_UNAVAILABLE,
            scores: calculateScores(recentTrades, volumeRecent, volumeRecent),
          },
      latestTrades: recentTrades.slice(0, 50),
      marketsMostTraded,
      outcomesTraded,
      limitations: [
        "Trader profile and trades come from public Polymarket endpoints only.",
        "No wallet, private key, order, or trading endpoint is used.",
        "If Polymarket does not expose a field, BLACK-GOAT returns null/unavailable.",
      ],
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket trader profile request failed.", error);
  }
});

app.get("/api/polymarket/trades/live", async (req, res) => {
  try {
    const period = readPeriod(req.query.period);
    const limit = readLimit(req.query.limit, 100, 250);
    const result = await fetchDataApiTrades(POLYMARKET_TRADES_FETCH_LIMIT);
    const trades = filterTradesByPeriod(result.data.map(normalizeTrade), period).slice(0, limit);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: DATA_SOURCE_REAL,
      source: result.endpoint,
      period,
      count: trades.length,
      trades,
      limitations: [
        "Live tape uses public Data API polling because a public trader WebSocket with wallet-level trade data is not documented.",
        "No simulated trades are generated.",
      ],
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket live trades request failed.", error);
  }
});

app.get("/api/polymarket/top-traders", async (req, res) => {
  try {
    const period = readTopTraderPeriod(req.query.period);
    const sort = readTopTraderSort(req.query.sort);
    const limit = readLimit(req.query.limit, 5, 25);
    const result = await fetchTopTradersCached(period, sort, limit);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: DATA_SOURCE_REAL,
      period,
      sort,
      count: result.traders.length,
      source: result.source,
      stale: result.stale ?? false,
      traders: result.traders,
      limitations: [
        "Top Trader is read-only and uses public Polymarket data only.",
        "PnL is available for official leaderboard periods only.",
        "Short periods are derived from public recent trades and do not estimate private PnL.",
      ],
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket top traders request failed.", error);
  }
});

app.post("/api/polymarket/batch-prices-history", async (req, res) => {
  try {
    const markets = readStringArray(req.body?.markets).slice(0, 20);
    if (markets.length === 0) {
      res.status(400).json({
        ok: false,
        appName: APP_NAME,
        mode: MODE,
        message: "markets must contain at least one token id.",
        time: new Date().toISOString(),
      });
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const startTs = readUnixTimestamp(req.body?.startTs ?? req.body?.start_ts) ?? nowSeconds - 6 * 60 * 60;
    const endTs = readUnixTimestamp(req.body?.endTs ?? req.body?.end_ts) ?? nowSeconds;
    const interval = readPriceHistoryInterval(req.body?.interval);
    const fidelity = readPositiveInteger(req.body?.fidelity, 10);
    const result = await fetchBatchPricesHistory({ endTs, fidelity, interval, markets, startTs });

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      endpoint: result.endpoint,
      history: result.data.history ?? {},
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket price history request failed.", error);
  }
});

setupStaticFrontend();
setupClientWebSocket();
startCryptoPriceCache();

server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} ${MODE} listening on http://${HOST}:${PORT}`);
});

async function fetchPolymarketMarkets(limit: number): Promise<FetchJsonResult<GammaMarket[]>> {
  const startedAt = Date.now();
  const fallbackLimit = Math.max(limit * 3, limit + 6);
  const [featuredSettled, fallbackSettled] = await Promise.allSettled([
    fetchFeaturedUpDownMarkets(Math.min(limit, FEATURED_UPDOWN_SYMBOLS.length)),
    fetchGammaMarketsByVolume(fallbackLimit),
  ]);
  const featuredResult =
    featuredSettled.status === "fulfilled"
      ? featuredSettled.value
      : {
          data: [],
          endpoint: "",
          latencyMs: 0,
          status: 503,
        };
  const fallbackResult =
    fallbackSettled.status === "fulfilled"
      ? fallbackSettled.value
      : {
          data: [],
          endpoint: "",
          latencyMs: 0,
          status: 503,
        };
  const combined = mergeMarkets(featuredResult.data, fallbackResult.data, limit);

  if (combined.length === 0 && featuredSettled.status === "rejected" && fallbackSettled.status === "rejected") {
    throw new Error(
      `Polymarket Gamma unavailable: ${String(featuredSettled.reason)} | ${String(fallbackSettled.reason)}`,
    );
  }

  return {
    data: combined,
    endpoint:
      featuredResult.endpoint === ""
        ? fallbackResult.endpoint
        : fallbackResult.endpoint === ""
          ? featuredResult.endpoint
          : `${featuredResult.endpoint} | ${fallbackResult.endpoint}`,
    latencyMs: Date.now() - startedAt,
    status: 200,
  };
}

async function fetchPolymarketMarketsCached(limit: number): Promise<FetchJsonResult<GammaMarket[]>> {
  return readThroughCache(marketsCache, limit, () => fetchPolymarketMarkets(limit));
}

async function fetchGammaMarketsByVolume(limit: number): Promise<FetchJsonResult<GammaMarket[]>> {
  const url = new URL("/markets", POLYMARKET_API_BASE);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", String(limit));

  return fetchJson<GammaMarket[]>(url);
}

async function fetchFeaturedUpDownMarkets(limit: number): Promise<FetchJsonResult<GammaMarket[]>> {
  const startedAt = Date.now();
  const epochs = buildUpDownEpochCandidates();
  const requests = FEATURED_UPDOWN_SYMBOLS.flatMap((symbol) =>
    epochs.map((epoch) => ({
      epoch,
      slug: `${symbol}-updown-5m-${epoch}`,
      symbol,
    })),
  );

  const settled = await Promise.allSettled(requests.map((request) => fetchGammaEventBySlug(request.slug)));
  const candidates = settled
    .map((result, index) => {
      if (result.status !== "fulfilled") {
        return null;
      }

      const request = requests[index];
      if (request === undefined) {
        return null;
      }

      const market = buildMarketFromEvent(result.value.data);
      return market === null
        ? null
        : {
            endpoint: result.value.endpoint,
            epoch: request.epoch,
            market,
            symbol: request.symbol,
          };
    })
    .filter((item): item is { endpoint: string; epoch: number; market: GammaMarket; symbol: (typeof FEATURED_UPDOWN_SYMBOLS)[number] } => item !== null);

  const nowMs = Date.now();
  const selected = FEATURED_UPDOWN_SYMBOLS.flatMap((symbol) => {
    const symbolCandidates = candidates
      .filter((item) => item.symbol === symbol)
      .filter((item) => item.market.active !== false && item.market.closed !== true)
      .sort((left, right) => scoreUpDownMarket(left.market, nowMs) - scoreUpDownMarket(right.market, nowMs));

    const chosen = symbolCandidates[0];
    return chosen === undefined ? [] : [chosen];
  });
  const enriched = await Promise.all(
    selected.map(async (item) => ({
      ...item,
      market: await enrichMarketTargetFromPublicPage(item.market),
    })),
  );

  return {
    data: enriched.map((item) => item.market).slice(0, limit),
    endpoint: enriched.map((item) => item.endpoint).join(" | "),
    latencyMs: Date.now() - startedAt,
    status: 200,
  };
}

async function enrichMarketTargetFromPublicPage(market: GammaMarket): Promise<GammaMarket> {
  if (resolvePolymarketTarget(market) !== null || market.slug === undefined) {
    return market;
  }

  const target = await fetchPolymarketPageTarget(market.slug).catch(() => null);
  if (target === null) {
    return market;
  }

  if (isCuratedCryptoUpDownMarket(market) && !isPublicPageTargetPlausible(market, target)) {
    return market;
  }

  return { ...market, priceToBeat: target };
}

async function fetchPolymarketPageTarget(slug: string): Promise<number | null> {
  const url = new URL(`/event/${slug}`, "https://polymarket.com");
  const response = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": `${APP_NAME}/0.2.0 TEST`,
    },
    signal: AbortSignal.timeout(Math.min(POLYMARKET_REQUEST_TIMEOUT_MS, 3_500)),
  });

  if (!response.ok) {
    return null;
  }

  return extractTargetForSlugFromHtml(await response.text(), slug);
}

function extractTargetForSlugFromHtml(html: string, slug: string): number | null {
  let position = -1;
  while ((position = html.indexOf(slug, position + 1)) !== -1) {
    const start = Math.max(0, position - 1_500);
    const end = Math.min(html.length, position + 1_500);
    const snippet = html.slice(start, end);
    if (!snippet.includes('"active":true') || !snippet.includes('"closed":false')) {
      continue;
    }

    const match = snippet.match(/"priceToBeat"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match?.[1] === undefined) {
      continue;
    }

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

async function fetchGammaEventBySlug(slug: string): Promise<FetchJsonResult<GammaEvent>> {
  const url = new URL(`/events/slug/${slug}`, POLYMARKET_API_BASE);
  return fetchJson<GammaEvent>(url);
}

function buildMarketFromEvent(event: GammaEvent): GammaMarket | null {
  const market = event.markets?.[0];
  if (market === undefined) {
    return null;
  }

  return {
    ...market,
    description: market.description ?? event.description,
    eventStartTime: market.eventStartTime ?? event.startTime,
    icon: market.icon ?? event.icon,
    image: market.image ?? event.image,
    priceToBeat: resolvePolymarketTarget(market, event),
    finalPrice: event.eventMetadata?.finalPrice,
    question: market.question ?? event.title,
    sourceType: "CURATED_LIVE_CRYPTO",
  } as GammaMarket;
}

function resolvePolymarketTarget(market: GammaMarket, event?: GammaEvent): number | null {
  const directCandidates = [
    market.priceToBeat,
    event?.eventMetadata?.priceToBeat,
    (market as Record<string, unknown>).price_to_beat,
    (market as Record<string, unknown>).priceToBeatValue,
    (event as Record<string, unknown> | undefined)?.priceToBeat,
  ];

  for (const candidate of directCandidates) {
    const parsed = parseNumber(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  const cachedOpeningPrice = resolveCachedOpeningPrice(market);
  if (cachedOpeningPrice !== null) {
    return cachedOpeningPrice;
  }

  const textCandidates = [
    market.description,
    (market as Record<string, unknown>).rules,
    (market as Record<string, unknown>).resolutionCriteria,
    event?.description,
    event?.title,
  ];

  for (const candidate of textCandidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const parsed = extractTargetFromText(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function resolveCachedOpeningPrice(market: GammaMarket): number | null {
  const startMs = Date.parse(market.eventStartTime ?? market.startDate ?? "");
  const symbol = resolveMarketChainlinkSymbol(market);
  if (Number.isNaN(startMs) || symbol === null) {
    return null;
  }

  const history = cryptoPriceHistory.get(symbol);
  if (history === undefined || history.length === 0) {
    return null;
  }

  const point = history
    .filter((item) => item.timestamp >= startMs)
    .sort((left, right) => left.timestamp - right.timestamp)[0];
  return point === undefined || point.timestamp - startMs > 120_000 ? null : point.price;
}

function isCuratedCryptoUpDownMarket(market: GammaMarket) {
  const text = `${market.slug ?? ""} ${market.question ?? ""}`.toLowerCase();
  return market.sourceType === "CURATED_LIVE_CRYPTO" || text.includes("updown") || text.includes("up or down");
}

function isPublicPageTargetPlausible(market: GammaMarket, target: number) {
  const startMs = Date.parse(market.eventStartTime ?? market.startDate ?? "");
  const symbol = resolveMarketChainlinkSymbol(market);
  if (!Number.isFinite(target) || target <= 0 || Number.isNaN(startMs) || symbol === null) {
    return false;
  }

  const nearbyPrice = getNearestCachedCryptoPrice(symbol, startMs, 20_000);
  if (nearbyPrice === null || nearbyPrice <= 0) {
    return true;
  }

  const distance = Math.abs(target - nearbyPrice) / nearbyPrice;
  return distance <= 0.0025;
}

function getNearestCachedCryptoPrice(symbol: string, timestampMs: number, toleranceMs: number) {
  const history = cryptoPriceHistory.get(symbol);
  if (history === undefined || history.length === 0) {
    return null;
  }

  const nearest = history
    .map((point) => ({ distance: Math.abs(point.timestamp - timestampMs), point }))
    .filter((item) => item.distance <= toleranceMs)
    .sort((left, right) => left.distance - right.distance)[0];

  return nearest?.point.price ?? null;
}

function resolveMarketChainlinkSymbol(market: GammaMarket): string | null {
  const text = `${market.slug ?? ""} ${market.question ?? ""}`.toLowerCase();
  if (text.includes("doge") || text.includes("dogecoin")) {
    return "doge/usd";
  }
  if (text.includes("hype") || text.includes("hyperliquid")) {
    return "hype/usd";
  }
  if (text.includes("bnb")) {
    return "bnb/usd";
  }
  if (text.includes("eth")) {
    return "eth/usd";
  }
  if (text.includes("sol")) {
    return "sol/usd";
  }
  if (text.includes("xrp")) {
    return "xrp/usd";
  }
  if (text.includes("btc") || text.includes("bitcoin")) {
    return "btc/usd";
  }

  return null;
}

function extractTargetFromText(value: string): number | null {
  const patterns = [
    /price\s*(?:to\s*)?beat[^$\d-]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /target[^$\d-]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /opening\s*price[^$\d-]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1] === undefined) {
      continue;
    }

    const parsed = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function buildUpDownEpochCandidates() {
  const currentWindow = Math.floor(Math.floor(Date.now() / 1_000) / 300) * 300;
  const epochs: number[] = [];

  for (let offset = -FEATURED_UPDOWN_LOOKBACK_WINDOWS; offset <= FEATURED_UPDOWN_LOOKAHEAD_WINDOWS; offset += 1) {
    epochs.push(currentWindow + offset * 300);
  }

  return epochs;
}

function scoreUpDownMarket(market: GammaMarket, nowMs: number) {
  const startMs = Date.parse(market.eventStartTime ?? market.startDate ?? "");
  const endMs = Date.parse(market.endDate ?? "");
  const safeStartMs = Number.isNaN(startMs) ? nowMs : startMs;
  const safeEndMs = Number.isNaN(endMs) ? safeStartMs + 300_000 : endMs;

  if (safeStartMs <= nowMs && nowMs < safeEndMs) {
    return 0;
  }

  if (safeStartMs > nowMs) {
    return safeStartMs - nowMs;
  }

  return 86_400_000 + Math.abs(nowMs - safeEndMs);
}

function mergeMarkets(featured: GammaMarket[], fallback: GammaMarket[], limit: number) {
  const seen = new Set<string>();
  const merged: GammaMarket[] = [];

  for (const market of [...featured, ...fallback]) {
    const slug = market.slug ?? String(market.id ?? market.question ?? "");
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }

    if (market.closed === true || market.active === false || !hasTradableTokens(market)) {
      continue;
    }

    seen.add(slug);
    merged.push(market);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function hasTradableTokens(market: GammaMarket) {
  return parseStringArray(market.clobTokenIds).length > 0 && parseStringArray(market.outcomes).length > 0;
}

async function fetchDataApiTrades(
  limit: number,
  user?: string,
  options: { takerOnly?: boolean } = {},
): Promise<FetchJsonResult<DataApiTrade[]>> {
  const url = new URL("/trades", POLYMARKET_DATA_API_BASE);
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit), 1), 10_000)));
  url.searchParams.set("takerOnly", String(options.takerOnly ?? false));

  if (user !== undefined) {
    url.searchParams.set("user", user);
  }

  return fetchJson<DataApiTrade[]>(url);
}

async function fetchTopTraders(
  period: TopTraderPeriod,
  sort: TopTraderSort,
  limit: number,
): Promise<{ source: string; traders: TopTrader[] }> {
  if (isLeaderboardPeriod(period)) {
    const result = await fetchLeaderboard(toLeaderboardTimePeriod(period));
    const traders = buildTopTradersFromLeaderboard(result.data, sort).slice(0, limit);
    return { source: result.endpoint, traders };
  }

  const result = await fetchDataApiTrades(1_000, undefined, { takerOnly: true });
  const trades = filterTradesByTopPeriod(result.data.map(normalizeTrade), period);
  const traders = buildTopTradersFromTrades(trades, sort).slice(0, limit);
  return { source: result.endpoint, traders };
}

async function fetchTopTradersCached(
  period: TopTraderPeriod,
  sort: TopTraderSort,
  limit: number,
): Promise<{ source: string; stale?: boolean; traders: TopTrader[] }> {
  return readThroughCache(topTradersCache, `${period}:${sort}:${limit}`, () => fetchTopTraders(period, sort, limit));
}

async function fetchLeaderboard(timePeriod: LeaderboardTimePeriod): Promise<FetchJsonResult<LeaderboardEntry[]>> {
  const url = new URL("/v1/leaderboard", POLYMARKET_DATA_API_BASE);
  url.searchParams.set("timePeriod", timePeriod);
  return fetchJson<LeaderboardEntry[]>(url);
}

async function fetchBatchPricesHistory({
  endTs,
  fidelity,
  interval,
  markets,
  startTs,
}: {
  endTs: number;
  fidelity: number;
  interval: "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h";
  markets: string[];
  startTs: number;
}): Promise<FetchJsonResult<{ history?: Record<string, Array<{ t: number; p: number }>> }>> {
  const url = new URL("/batch-prices-history", POLYMARKET_CLOB_API_BASE);
  return fetchJsonPost(url, {
    end_ts: endTs,
    fidelity,
    interval,
    markets,
    start_ts: startTs,
  });
}

async function fetchPublicProfile(address: string): Promise<{
  profile: PublicProfile | null;
  dataSourceStatus: DataSourceStatus;
  endpoint: string;
  latencyMs: number | null;
}> {
  const url = new URL("/public-profile", POLYMARKET_API_BASE);
  url.searchParams.set("address", address);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": `${APP_NAME}/0.3.0 TEST`,
      },
      signal: AbortSignal.timeout(POLYMARKET_REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;

    if (response.status === 404) {
      return {
        profile: null,
        dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
        endpoint: url.toString(),
        latencyMs,
      };
    }

    if (!response.ok) {
      return {
        profile: null,
        dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
        endpoint: url.toString(),
        latencyMs,
      };
    }

    return {
      profile: (await response.json()) as PublicProfile,
      dataSourceStatus: DATA_SOURCE_REAL,
      endpoint: url.toString(),
      latencyMs,
    };
  } catch {
    return {
      profile: null,
      dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
      endpoint: url.toString(),
      latencyMs: null,
    };
  }
}

async function fetchJson<T>(url: URL): Promise<FetchJsonResult<T>> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": `${APP_NAME}/0.2.0 TEST`,
    },
    signal: AbortSignal.timeout(POLYMARKET_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  return {
    data: JSON.parse(text) as T,
    endpoint: url.toString(),
    latencyMs,
    status: response.status,
  };
}

async function fetchJsonPost<T>(url: URL, body: Record<string, unknown>): Promise<FetchJsonResult<T>> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `${APP_NAME}/0.2.0 TEST`,
    },
    method: "POST",
    signal: AbortSignal.timeout(POLYMARKET_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  return {
    data: JSON.parse(text) as T,
    endpoint: url.toString(),
    latencyMs,
    status: response.status,
  };
}

async function readThroughCache<K, V>(
  cache: Map<K, CacheEntry<V>>,
  key: K,
  load: () => Promise<V>,
): Promise<V & { stale?: boolean }> {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached !== undefined && now - cached.storedAt <= POLYMARKET_CACHE_TTL_MS) {
    return {
      ...cached.value,
      stale: false,
    };
  }

  try {
    const value = await load();
    cache.set(key, {
      storedAt: Date.now(),
      value,
    });

    return {
      ...value,
      stale: false,
    };
  } catch (error) {
    if (cached !== undefined && now - cached.storedAt <= POLYMARKET_STALE_TTL_MS) {
      return {
        ...cached.value,
        stale: true,
      };
    }

    throw error;
  }
}

function setupClientWebSocket() {
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === CLIENT_WS_PATH) {
      clientWss.handleUpgrade(request, socket, head, (client) => {
        clientWss.emit("connection", client, request);
      });
      return;
    }

    if (pathname === CRYPTO_PRICES_WS_PATH) {
      cryptoPricesWss.handleUpgrade(request, socket, head, (client) => {
        cryptoPricesWss.emit("connection", client, request);
        attachCryptoPriceRelay(client, {
          chainlinkSymbol: readCryptoSymbol(url.searchParams.get("chainlinkSymbol"), "btc/usd"),
          fallbackSymbol: readCryptoSymbol(url.searchParams.get("fallbackSymbol"), "btcusdt"),
        });
      });
      return;
    }

    if (pathname === TRADERS_WS_PATH) {
      tradersWss.handleUpgrade(request, socket, head, (client) => {
        tradersWss.emit("connection", client, request);
        attachTradersRelay(client, {
          minTrades: readMinimumNumber(url.searchParams.get("minTrades")),
          minVolume: readMinimumNumber(url.searchParams.get("minVolume")),
          period: readPeriod(url.searchParams.get("period")),
          search: readQueryString(url.searchParams.get("search")),
          sort: readTraderSort(url.searchParams.get("sort")),
        });
      });
      return;
    }

      socket.destroy();
  });

  clientWss.on("connection", (client) => {
    attachPolymarketRelay(client);
  });
}

function startCryptoPriceCache() {
  const symbols = ["btc/usd", "eth/usd", "sol/usd", "xrp/usd", "doge/usd", "hype/usd", "bnb/usd"];
  let upstream: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnect: NodeJS.Timeout | undefined;

  const connect = () => {
    if (reconnect !== undefined) {
      clearTimeout(reconnect);
      reconnect = undefined;
    }

    const ws = new WebSocket(POLYMARKET_RTDS_WS_URL, {
      handshakeTimeout: POLYMARKET_WS_TIMEOUT_MS,
    });
    upstream = ws;

    ws.on("open", () => {
      if (ws !== upstream) {
        return;
      }

      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: symbols.map((symbol) => ({
            filters: JSON.stringify({ symbol }),
            topic: "crypto_prices_chainlink",
            type: "*",
          })),
        }),
      );

      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("PING");
        }
      }, 5_000);
    });

    ws.on("message", (rawMessage) => {
      if (ws !== upstream) {
        return;
      }

      const message = rawMessage.toString();
      if (message === "PONG") {
        return;
      }

      for (const payload of parsePayloads(message)) {
        for (const update of extractCryptoPriceUpdates(payload, null)) {
          if (update.source === "chainlink") {
            rememberCryptoPrice(update);
          }
        }
      }
    });

    ws.on("close", () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (upstream === ws) {
        upstream = null;
      }
      reconnect = setTimeout(connect, 2_000);
    });

    ws.on("error", () => {
      safeCloseWebSocket(ws);
    });
  };

  connect();
}

function attachPolymarketRelay(client: WebSocket) {
  let upstream: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let lastPingAt: number | null = null;
  let lastLatencyMs: number | null = null;
  let clientClosed = false;
  let currentAssetIds: string[] = [];

  sendClient(client, {
    type: "status",
    status: "OFFLINE",
    latencyMs: null,
    message: "Waiting for subscription.",
    time: new Date().toISOString(),
  });

  client.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString()) as ClientMessage;
      const type = typeof message.type === "string" ? message.type : null;

      if (type !== "subscribe") {
        sendClientError(client, "Unsupported WebSocket message type.");
        return;
      }

      const assetIds = readAssetIds(message);
      if (assetIds.length === 0) {
        sendClientError(client, "Subscription requires assetIds.");
        return;
      }

      currentAssetIds = assetIds;
      connectUpstream(assetIds);
    } catch (error) {
      sendClientError(client, error instanceof Error ? error.message : String(error));
    }
  });

  client.on("close", () => {
    clientClosed = true;
    clearReconnect();
    closeUpstream();
  });

  function connectUpstream(assetIds: string[]) {
    clearReconnect();
    closeUpstream();

    const startedAt = Date.now();
    const ws = new WebSocket(POLYMARKET_WS_URL, {
      handshakeTimeout: POLYMARKET_WS_TIMEOUT_MS,
    });
    upstream = ws;

    ws.on("open", () => {
      if (ws !== upstream) {
        return;
      }

      lastLatencyMs = Date.now() - startedAt;
      ws.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      sendClient(client, {
        type: "status",
        status: "LIVE",
        latencyMs: lastLatencyMs,
        subscribedAssetCount: assetIds.length,
        time: new Date().toISOString(),
      });

      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          lastPingAt = Date.now();
          ws.send("PING");
        }
      }, 10_000);
    });

    ws.on("message", (rawMessage) => {
      if (ws !== upstream) {
        return;
      }

      handleUpstreamMessage(rawMessage);
    });

    ws.on("error", (error) => {
      if (ws === upstream) {
        sendClientError(client, `Polymarket WebSocket error: ${error.message}`);
      }
    });

    ws.on("close", (code, reason) => {
      if (ws !== upstream) {
        return;
      }

      clearHeartbeat();
      upstream = null;
      sendClient(client, {
        type: "status",
        status: "OFFLINE",
        latencyMs: lastLatencyMs,
        code,
        reason: reason.toString(),
        time: new Date().toISOString(),
      });

      if (!clientClosed && currentAssetIds.length > 0) {
        reconnect = setTimeout(() => {
          connectUpstream(currentAssetIds);
        }, 2_000);
      }
    });
  }

  function handleUpstreamMessage(rawMessage: RawData) {
    const message = rawMessage.toString();

    if (message === "PONG") {
      lastLatencyMs = lastPingAt === null ? lastLatencyMs : Date.now() - lastPingAt;
      sendClient(client, {
        type: "status",
        status: "LIVE",
        latencyMs: lastLatencyMs,
        subscribedAssetCount: currentAssetIds.length,
        time: new Date().toISOString(),
      });
      return;
    }

    const payloads = parsePayloads(message);
    for (const payload of payloads) {
      const marketEvent = extractMarketLifecycleUpdate(payload);
      if (marketEvent !== null) {
        sendClient(client, marketEvent);
      }

      const updates = extractPriceUpdates(payload, lastLatencyMs);
      for (const update of updates) {
        sendClient(client, update);
      }
    }
  }

  function closeUpstream() {
    clearHeartbeat();

    if (upstream !== null) {
      upstream.removeAllListeners();
      safeCloseWebSocket(upstream);
      upstream = null;
    }
  }

  function clearHeartbeat() {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function clearReconnect() {
    if (reconnect !== undefined) {
      clearTimeout(reconnect);
      reconnect = undefined;
    }
  }
}

function attachCryptoPriceRelay(
  client: WebSocket,
  symbols: {
    chainlinkSymbol: string;
    fallbackSymbol: string;
  },
) {
  let upstream: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let fallbackSubscribeTimer: NodeJS.Timeout | undefined;
  let lastPingAt: number | null = null;
  let lastLatencyMs: number | null = null;
  let chainlinkReceived = false;
  let fallbackSubscribed = false;
  let clientClosed = false;

  sendClient(client, {
    type: "status",
    status: "CONNECTING",
    endpoint: POLYMARKET_RTDS_WS_URL,
    message: "Connecting to Polymarket RTDS crypto price feed.",
    time: new Date().toISOString(),
  });

  connectUpstream();

  client.on("close", () => {
    clientClosed = true;
    clearReconnect();
    closeUpstream();
  });

  function connectUpstream() {
    clearReconnect();
    closeUpstream();
    chainlinkReceived = false;
    fallbackSubscribed = false;

    const startedAt = Date.now();
    const ws = new WebSocket(POLYMARKET_RTDS_WS_URL, {
      handshakeTimeout: POLYMARKET_WS_TIMEOUT_MS,
    });
    upstream = ws;

    ws.on("open", () => {
      if (ws !== upstream) {
        return;
      }

      lastLatencyMs = Date.now() - startedAt;
      subscribeToChainlink(ws);
      fallbackSubscribeTimer = setTimeout(() => subscribeToFallback(ws), 3_500);

      sendClient(client, {
        type: "status",
        status: "LIVE",
        chainlinkSymbol: symbols.chainlinkSymbol,
        fallbackSymbol: symbols.fallbackSymbol,
        latencyMs: lastLatencyMs,
        source: "POLYMARKET_RTDS",
        time: new Date().toISOString(),
      });

      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          lastPingAt = Date.now();
          ws.send("PING");
        }
      }, 5_000);
    });

    ws.on("message", (rawMessage) => {
      if (ws !== upstream) {
        return;
      }

      handleRtdsMessage(rawMessage);
    });

    ws.on("error", (error) => {
      if (ws === upstream) {
        sendClientError(client, `Polymarket RTDS error: ${error.message}`);
      }
    });

    ws.on("close", (code, reason) => {
      if (ws !== upstream) {
        return;
      }

      clearHeartbeat();
      clearFallbackSubscribeTimer();
      upstream = null;
      sendClient(client, {
        type: "status",
        status: "OFFLINE",
        code,
        latencyMs: lastLatencyMs,
        reason: reason.toString(),
        time: new Date().toISOString(),
      });

      if (!clientClosed) {
        reconnect = setTimeout(connectUpstream, 1_000);
      }
    });
  }

  function handleRtdsMessage(rawMessage: RawData) {
    const message = rawMessage.toString();
    if (message === "PONG") {
      lastLatencyMs = lastPingAt === null ? lastLatencyMs : Date.now() - lastPingAt;
      sendClient(client, {
        type: "status",
        status: "LIVE",
        latencyMs: lastLatencyMs,
        source: "POLYMARKET_RTDS",
        time: new Date().toISOString(),
      });
      return;
    }

    const payloads = parsePayloads(message);
    for (const payload of payloads) {
      const updates = extractCryptoPriceUpdates(payload, lastLatencyMs);
      for (const update of updates) {
        if (update.source === "chainlink") {
          chainlinkReceived = true;
          clearFallbackSubscribeTimer();
        }

        if (update.source === "binance" && chainlinkReceived) {
          continue;
        }

        if (update.source === "chainlink" && update.upstreamTimestamp !== null) {
          rememberCryptoPrice(update);
        }

        sendClient(client, update);
      }
    }
  }

  function subscribeToChainlink(ws: WebSocket) {
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            filters: JSON.stringify({ symbol: symbols.chainlinkSymbol }),
            topic: "crypto_prices_chainlink",
            type: "*",
          },
        ],
      }),
    );
  }

  function subscribeToFallback(ws: WebSocket) {
    if (ws !== upstream || ws.readyState !== WebSocket.OPEN || chainlinkReceived || fallbackSubscribed) {
      return;
    }

    fallbackSubscribed = true;
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            filters: JSON.stringify({ symbol: symbols.fallbackSymbol }),
            topic: "crypto_prices",
            type: "update",
          },
        ],
      }),
    );
  }

  function closeUpstream() {
    clearHeartbeat();
    clearFallbackSubscribeTimer();

    if (upstream !== null) {
      upstream.removeAllListeners();
      safeCloseWebSocket(upstream);
      upstream = null;
    }
  }

  function clearHeartbeat() {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function clearFallbackSubscribeTimer() {
    if (fallbackSubscribeTimer !== undefined) {
      clearTimeout(fallbackSubscribeTimer);
      fallbackSubscribeTimer = undefined;
    }
  }

  function clearReconnect() {
    if (reconnect !== undefined) {
      clearTimeout(reconnect);
      reconnect = undefined;
    }
  }
}

function attachTradersRelay(
  client: WebSocket,
  filters: {
    minTrades: number | null;
    minVolume: number | null;
    period: PeriodKey;
    search: string | null;
    sort: TraderSort;
  },
) {
  let closed = false;
  let polling = false;
  let snapshotSent = false;
  let timer: NodeJS.Timeout | undefined;
  let lastWsEventAt: string | null = null;
  let lastTradeEventAt: string | null = null;
  const wsEventTimes: number[] = [];
  const tradeEventTimes: number[] = [];
  const seenTradeIds = new Set<string>();

  sendClient(client, {
    type: "status",
    status: "OFFLINE",
    dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
    transport: "POLLING_PUBLIC_DATA_API",
    message: "Waiting for first public trades poll.",
    period: filters.period,
    time: new Date().toISOString(),
  });

  const poll = async () => {
    if (closed || polling) {
      return;
    }

    polling = true;
    const startedAt = Date.now();

    try {
      const result = await fetchDataApiTrades(Math.min(POLYMARKET_TRADES_FETCH_LIMIT, 300));
      const periodTrades = filterTradesByPeriod(result.data.map(normalizeTrade), filters.period);
      const trades = periodTrades.slice(0, 50);
      const isSnapshot = !snapshotSent;
      const payloadTrades = isSnapshot ? trades : trades.filter((trade) => !seenTradeIds.has(trade.id));

      for (const trade of trades) {
        seenTradeIds.add(trade.id);
      }

      if (seenTradeIds.size > 2_000) {
        seenTradeIds.clear();
        for (const trade of trades) {
          seenTradeIds.add(trade.id);
        }
      }

      snapshotSent = true;
      const now = Date.now();
      lastWsEventAt = new Date(now).toISOString();
      wsEventTimes.push(now);
      pruneMinuteWindow(wsEventTimes, now);
      pruneMinuteWindow(tradeEventTimes, now);

      if (payloadTrades.length > 0) {
        lastTradeEventAt = payloadTrades[0]?.time ?? new Date(now).toISOString();
        tradeEventTimes.push(
          ...payloadTrades.map((trade) => {
            const parsed = trade.time === null ? NaN : Date.parse(trade.time);
            return Number.isNaN(parsed) ? now : parsed;
          }),
        );
        pruneMinuteWindow(tradeEventTimes, now);
      }

      const activeTraders = buildActiveTraders(periodTrades, {
        minTrades: filters.minTrades,
        minVolume: filters.minVolume,
        search: filters.search,
        sort: filters.sort,
      }).slice(0, 100);

      sendClient(client, {
        type: "status",
        status: "LIVE",
        dataSourceStatus: DATA_SOURCE_REAL,
        transport: "POLLING_PUBLIC_DATA_API",
        latencyMs: Date.now() - startedAt,
        lastWsEventAt,
        lastTradeEventAt,
        newestTradeAt: trades[0]?.time ?? null,
        secondsSinceLastTradeEvent: secondsSince(lastTradeEventAt),
        wsEventsPerMinute: wsEventTimes.length,
        tradesReceivedPerMinute: tradeEventTimes.length,
        period: filters.period,
        time: new Date().toISOString(),
      });

      if (payloadTrades.length > 0) {
        sendClient(client, {
          type: "trades",
          snapshot: isSnapshot,
          dataSourceStatus: DATA_SOURCE_REAL,
          period: filters.period,
          count: payloadTrades.length,
          trades: payloadTrades,
          traders: activeTraders,
          lastWsEventAt,
          lastTradeEventAt,
          newestTradeAt: trades[0]?.time ?? null,
          secondsSinceLastTradeEvent: secondsSince(lastTradeEventAt),
          wsEventsPerMinute: wsEventTimes.length,
          tradesReceivedPerMinute: tradeEventTimes.length,
          time: new Date().toISOString(),
        });
      }
    } catch (error) {
      sendClient(client, {
        type: "status",
        status: "OFFLINE",
        dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
        transport: "POLLING_PUBLIC_DATA_API",
        message: error instanceof Error ? error.message : String(error),
        period: filters.period,
        time: new Date().toISOString(),
      });
    } finally {
      polling = false;
    }
  };

  void poll();
  timer = setInterval(() => {
    void poll();
  }, POLYMARKET_TRADES_POLL_MS);

  client.on("close", () => {
    closed = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
  });
}

function normalizeMarket(market: GammaMarket): PublicMarket {
  return {
    id: market.id === undefined ? null : String(market.id),
    question: market.question ?? null,
    slug: market.slug ?? null,
    image: market.image ?? null,
    icon: market.icon ?? null,
    description: market.description ?? null,
    outcomes: parseStringArray(market.outcomes),
    outcomePrices: parseStringArray(market.outcomePrices),
    clobTokenIds: parseStringArray(market.clobTokenIds),
    volume24hr: parseNumber(market.volume24hr ?? market.volume),
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    startDate: market.startDate ?? null,
    endDate: market.endDate ?? null,
    eventStartTime: market.eventStartTime ?? market.startDate ?? null,
    active: market.active ?? null,
    closed: market.closed ?? null,
    acceptingOrders: market.acceptingOrders ?? null,
    lastTradePrice: parseNumber(market.lastTradePrice),
    bestBid: parseNumber(market.bestBid),
    bestAsk: parseNumber(market.bestAsk),
    oneHourPriceChange: parseNumber(market.oneHourPriceChange),
    priceToBeat: resolvePolymarketTarget(market),
    finalPrice: parseNumber(market.finalPrice),
    sourceType: market.sourceType ?? "GAMMA_VOLUME",
  };
}

function normalizeTrade(trade: DataApiTrade): NormalizedTrade {
  const wallet = readString(trade.proxyWallet);
  const username = readString(trade.name);
  const pseudonym = readString(trade.pseudonym);
  const size = parseNumber(trade.size);
  const price = parseNumber(trade.price);
  const amount = size === null || price === null ? null : size * price;
  const timestampMs = parseTimestamp(trade.timestamp) ?? Date.now();
  const timestamp = timestampMs === null ? null : Math.floor(timestampMs / 1_000);
  const marketSlug = readString(trade.slug);
  const eventSlug = readString(trade.eventSlug);
  const marketTitle = readString(trade.title);
  const conditionId = readString(trade.conditionId);
  const asset = readString(trade.asset);
  const side = readString(trade.side);
  const outcome = readString(trade.outcome);
  const outcomeIndex = parseNumber(trade.outcomeIndex);
  const transactionHash = readString(trade.transactionHash);
  const profileImage = readString(trade.profileImageOptimized) ?? readString(trade.profileImage);
  const fallbackId = [
    wallet,
    asset,
    side,
    outcome,
    size?.toString() ?? "",
    price?.toString() ?? "",
    timestamp?.toString() ?? "",
  ].join(":");

  return {
    id: transactionHash === null ? fallbackId : `${transactionHash}:${wallet ?? "unknown"}:${asset ?? "asset"}:${outcomeIndex ?? "outcome"}`,
    wallet,
    trader: username ?? pseudonym ?? wallet,
    username,
    pseudonym,
    side,
    asset,
    conditionId,
    marketTitle,
    marketSlug,
    eventSlug,
    outcome,
    outcomeIndex: outcomeIndex === null ? null : Math.trunc(outcomeIndex),
    size,
    price,
    amount,
    amountSource: amount === null ? DATA_SOURCE_UNAVAILABLE : "DERIVED_FROM_REAL_SIZE_PRICE",
    timestamp,
    time: timestampMs === null ? null : new Date(timestampMs).toISOString(),
    transactionHash,
    profileImage,
    profileUrl: wallet === null ? null : buildProfileUrl(wallet),
    marketUrl: buildMarketUrl(eventSlug ?? marketSlug),
    dataSourceStatus: DATA_SOURCE_REAL,
  };
}

function normalizeProfile(profile: PublicProfile | null, fallbackWallet: string) {
  const displayUsernamePublic = profile?.displayUsernamePublic !== false;

  return {
    wallet: readString(profile?.proxyWallet) ?? fallbackWallet,
    username: displayUsernamePublic ? readString(profile?.name) : null,
    pseudonym: readString(profile?.pseudonym),
    bio: readString(profile?.bio),
    profileImage: readString(profile?.profileImage),
    xUsername: readString(profile?.xUsername),
    verifiedBadge: typeof profile?.verifiedBadge === "boolean" ? profile.verifiedBadge : null,
    createdAt: readString(profile?.createdAt),
  };
}

function filterTradesByPeriod(trades: NormalizedTrade[], period: PeriodKey): NormalizedTrade[] {
  const cutoff = Math.floor(Date.now() / 1_000) - PERIOD_SECONDS[period];

  return trades
    .filter((trade) => trade.timestamp !== null && trade.timestamp >= cutoff)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
}

function filterTradesByTopPeriod(trades: NormalizedTrade[], period: keyof typeof TOP_TRADER_PERIOD_SECONDS): NormalizedTrade[] {
  const cutoff = Math.floor(Date.now() / 1_000) - TOP_TRADER_PERIOD_SECONDS[period];

  return trades
    .filter((trade) => trade.timestamp !== null && trade.timestamp >= cutoff)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
}

function buildTopTradersFromTrades(trades: NormalizedTrade[], sort: TopTraderSort): TopTrader[] {
  const grouped = new Map<
    string,
    {
      wallet: string;
      username: string | null;
      profileImage: string | null;
      trades: NormalizedTrade[];
      volume: number;
      lastTrade: NormalizedTrade;
    }
  >();

  for (const trade of trades) {
    if (trade.wallet === null) {
      continue;
    }

    const current = grouped.get(trade.wallet);
    if (current === undefined) {
      grouped.set(trade.wallet, {
        wallet: trade.wallet,
        username: trade.username ?? trade.pseudonym ?? null,
        profileImage: trade.profileImage,
        trades: [trade],
        volume: trade.amount ?? trade.size ?? 0,
        lastTrade: trade,
      });
      continue;
    }

    current.trades.push(trade);
    current.volume += trade.amount ?? trade.size ?? 0;
    current.username = current.username ?? trade.username ?? trade.pseudonym;
    current.profileImage = current.profileImage ?? trade.profileImage;
    if ((trade.timestamp ?? 0) > (current.lastTrade.timestamp ?? 0)) {
      current.lastTrade = trade;
    }
  }

  const groups = Array.from(grouped.values());
  const maxVolume = Math.max(0, ...groups.map((group) => group.volume));
  const topTraders = groups.map((group) => {
    const mainMarket = readMainMarket(group.trades);
    const scores = calculateTraderGlobalScore({
      lastActivity: group.lastTrade.time,
      maxVolume,
      price: group.lastTrade.price,
      trades: group.trades,
      tradesCount: group.trades.length,
      volume: group.volume,
    });

    return {
      rank: 0,
      wallet: group.wallet,
      username: group.username,
      profileImage: group.profileImage,
      profileUrl: buildProfileUrl(group.wallet),
      mainMarket: mainMarket.title,
      volume: group.volume,
      pnl: null,
      trades: group.trades.length,
      averagePlacement: calculateAveragePlacement(group.volume, group.trades.length) ?? 0,
      marketsCount: countMarkets(group.trades),
      lastActivity: group.lastTrade.time,
      scores,
      dataSourceStatus: DATA_SOURCE_REAL as DataSourceStatus,
    };
  });

  return rankTopTraders(sortTopTraders(topTraders, sort));
}

function buildTopTradersFromLeaderboard(entries: LeaderboardEntry[], sort: TopTraderSort): TopTrader[] {
  const maxVolume = Math.max(0, ...entries.map((entry) => parseNumber(entry.vol ?? entry.volume) ?? 0));
  const traders: TopTrader[] = entries.flatMap((entry, index) => {
      const wallet = readString(entry.proxyWallet);
      if (wallet === null) {
        return [];
      }

      const volume = parseNumber(entry.vol ?? entry.volume) ?? 0;
      const pnl = parseNumber(entry.pnl);
      const scores = calculateTraderGlobalScore({
        lastActivity: null,
        maxVolume,
        price: null,
        trades: [],
        tradesCount: 0,
        volume,
      });

      return [{
        rank: parseNumber(entry.rank) ?? index + 1,
        wallet,
        username: readString(entry.userName) ?? readString(entry.name) ?? readString(entry.pseudonym),
        profileImage: readString(entry.profileImage),
        profileUrl: buildProfileUrl(wallet),
        mainMarket: "Official leaderboard",
        volume,
        pnl,
        trades: 0,
        averagePlacement: 0,
        marketsCount: 0,
        lastActivity: null,
        scores,
        dataSourceStatus: DATA_SOURCE_REAL as DataSourceStatus,
      }];
    });

  return rankTopTraders(sortTopTraders(traders, sort));
}

function sortTopTraders(traders: TopTrader[], sort: TopTraderSort): TopTrader[] {
  return [...traders].sort((left, right) => {
    if (sort === "pnl") {
      return (right.pnl ?? Number.NEGATIVE_INFINITY) - (left.pnl ?? Number.NEGATIVE_INFINITY);
    }
    if (sort === "volume") {
      return right.volume - left.volume;
    }
    if (sort === "activity") {
      return right.scores.activityScore - left.scores.activityScore;
    }
    return right.scores.globalScore - left.scores.globalScore;
  });
}

function rankTopTraders(traders: TopTrader[]): TopTrader[] {
  return traders.map((trader, index) => ({
    ...trader,
    rank: index + 1,
  }));
}

function buildActiveTraders(
  trades: NormalizedTrade[],
  filters: {
    minTrades: number | null;
    minVolume: number | null;
    search: string | null;
    sort: TraderSort;
  },
): ActiveTrader[] {
  const grouped = new Map<
    string,
    {
      wallet: string;
      username: string | null;
      pseudonym: string | null;
      trades: NormalizedTrade[];
      volumeRecent: number;
      lastTrade: NormalizedTrade;
    }
  >();

  for (const trade of trades) {
    if (trade.wallet === null) {
      continue;
    }

    const current = grouped.get(trade.wallet);
    if (current === undefined) {
      grouped.set(trade.wallet, {
        wallet: trade.wallet,
        username: trade.username,
        pseudonym: trade.pseudonym,
        trades: [trade],
        volumeRecent: trade.amount ?? 0,
        lastTrade: trade,
      });
      continue;
    }

    current.trades.push(trade);
    current.volumeRecent += trade.amount ?? 0;
    if ((trade.timestamp ?? 0) > (current.lastTrade.timestamp ?? 0)) {
      current.lastTrade = trade;
      current.username = current.username ?? trade.username;
      current.pseudonym = current.pseudonym ?? trade.pseudonym;
    }
  }

  const maxVolume = Math.max(0, ...Array.from(grouped.values()).map((item) => item.volumeRecent));
  const normalizedSearch = filters.search?.toLowerCase() ?? null;
  const traders = Array.from(grouped.values()).map((item) => {
    const tradesRecent = item.trades.length;

    return {
      id: item.wallet,
      wallet: item.wallet,
      username: item.username,
      pseudonym: item.pseudonym,
      volumeRecent: item.volumeRecent,
      tradesRecent,
      lastActivity: item.lastTrade.time,
      market: item.lastTrade.marketTitle,
      outcome: item.lastTrade.outcome,
      price: item.lastTrade.price,
      amount: item.lastTrade.amount,
      averagePlacement: calculateAveragePlacement(item.volumeRecent, tradesRecent),
      profileUrl: buildProfileUrl(item.wallet),
      dataSourceStatus: DATA_SOURCE_REAL as DataSourceStatus,
      scores: calculateScores(item.trades, item.volumeRecent, maxVolume),
    };
  });

  const filtered = traders.filter((trader) => {
    if (filters.minVolume !== null && trader.volumeRecent < filters.minVolume) {
      return false;
    }

    if (filters.minTrades !== null && trader.tradesRecent < filters.minTrades) {
      return false;
    }

    if (normalizedSearch !== null && !traderMatchesSearch(trader, normalizedSearch)) {
      return false;
    }

    return true;
  });

  return filtered.sort((left, right) => {
    if (filters.sort === "indicative_score") {
      return compareNullableScore(right.scores.indicativeScore, left.scores.indicativeScore);
    }

    if (filters.sort === "activity") {
      return compareNullableScore(right.scores.activityScore, left.scores.activityScore);
    }

    if (filters.sort === "volume") {
      return right.volumeRecent - left.volumeRecent;
    }

    if (filters.sort === "consistency") {
      return compareNullableScore(right.scores.consistencyScore, left.scores.consistencyScore);
    }

    if (filters.sort === "risk") {
      return compareNullableScore(right.scores.riskScore, left.scores.riskScore);
    }

    if (filters.sort === "last_activity") {
      return new Date(right.lastActivity ?? 0).getTime() - new Date(left.lastActivity ?? 0).getTime();
    }

    if (filters.sort === "trades") {
      return right.tradesRecent - left.tradesRecent;
    }

    if (filters.sort === "average_placement") {
      return (right.averagePlacement ?? -1) - (left.averagePlacement ?? -1);
    }

    return compareNullableScore(right.scores.overallScore, left.scores.overallScore);
  });
}

function traderMatchesSearch(
  trader: Pick<ActiveTrader, "pseudonym" | "username" | "wallet">,
  normalizedSearch: string,
): boolean {
  return [trader.wallet, trader.username, trader.pseudonym]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLowerCase().includes(normalizedSearch));
}

function buildMostTradedMarkets(trades: NormalizedTrade[]) {
  const grouped = new Map<
    string,
    {
      conditionId: string | null;
      marketTitle: string | null;
      marketSlug: string | null;
      marketUrl: string | null;
      trades: number;
      volume: number;
      lastActivity: string | null;
    }
  >();

  for (const trade of trades) {
    const key = trade.conditionId ?? trade.marketSlug ?? trade.marketTitle ?? "unknown";
    const current = grouped.get(key);

    if (current === undefined) {
      grouped.set(key, {
        conditionId: trade.conditionId,
        marketTitle: trade.marketTitle,
        marketSlug: trade.marketSlug,
        marketUrl: trade.marketUrl,
        trades: 1,
        volume: trade.amount ?? 0,
        lastActivity: trade.time,
      });
      continue;
    }

    current.trades += 1;
    current.volume += trade.amount ?? 0;
    if (new Date(trade.time ?? 0).getTime() > new Date(current.lastActivity ?? 0).getTime()) {
      current.lastActivity = trade.time;
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.volume - left.volume || right.trades - left.trades)
    .slice(0, 10);
}

function buildOutcomesTraded(trades: NormalizedTrade[]) {
  const grouped = new Map<
    string,
    {
      outcome: string | null;
      trades: number;
      volume: number;
      lastActivity: string | null;
    }
  >();

  for (const trade of trades) {
    const key = trade.outcome ?? "unavailable";
    const current = grouped.get(key);

    if (current === undefined) {
      grouped.set(key, {
        outcome: trade.outcome,
        trades: 1,
        volume: trade.amount ?? 0,
        lastActivity: trade.time,
      });
      continue;
    }

    current.trades += 1;
    current.volume += trade.amount ?? 0;
    if (new Date(trade.time ?? 0).getTime() > new Date(current.lastActivity ?? 0).getTime()) {
      current.lastActivity = trade.time;
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.trades - left.trades || right.volume - left.volume)
    .slice(0, 10);
}

function calculateScores(trades: NormalizedTrade[], volume: number, maxVolume: number): TraderScores {
  if (trades.length === 0) {
    return emptyScores();
  }

  const activityScore = clampScore(Math.log1p(trades.length) * 32);
  const volumeScore = maxVolume > 0 ? clampScore((volume / maxVolume) * 100) : null;
  const timestampBuckets = new Set(
    trades
      .map((trade) => trade.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .map((timestamp) => Math.floor(timestamp / 300)),
  );
  const consistencyScore =
    timestampBuckets.size === 0
      ? null
      : trades.length === 1
        ? volumeScore !== null && volumeScore >= 90
          ? 35
          : 12
        : clampScore((timestampBuckets.size / Math.min(trades.length, 12)) * 100);
  const indicativeScore = calculateIndicativeScore(activityScore, volumeScore, consistencyScore, trades.length);
  const risk = calculateTraderRisk({
    activityScore,
    averagePlacement: calculateAveragePlacement(volume, trades.length),
    consistencyScore,
    lastActivity: trades[0]?.time ?? null,
    price: trades[0]?.price ?? null,
    trades,
    tradesRecent: trades.length,
    volumeRecent: volume,
  });
  const overallScore = calculateProfileQualityScore({
    activityScore,
    consistencyScore,
    indicativeScore,
    riskScore: risk.score,
    volumeScore,
  });

  return {
    indicativeScore,
    activityScore,
    volumeScore,
    consistencyScore,
    riskScore: risk.score,
    riskLabel: risk.label,
    riskFactors: risk.factors,
    overallScore,
    disclaimer: "Score analytique indicatif en lecture seule, pas un conseil financier.",
  };
}

function emptyScores(): TraderScores {
  return {
    indicativeScore: null,
    activityScore: null,
    volumeScore: null,
    consistencyScore: null,
    riskScore: 75,
    riskLabel: "Élevé",
    riskFactors: ["Données publiques insuffisantes", "Régularité partiellement mesurée", "Concentration marché partiellement mesurée"],
    overallScore: null,
    disclaimer: "Score analytique indicatif en lecture seule, pas un conseil financier.",
  };
}

function calculateTraderRisk(trader: {
  activityScore: number | null;
  averagePlacement: number | null;
  consistencyScore: number | null;
  lastActivity: string | null;
  price: number | null;
  trades: NormalizedTrade[];
  tradesRecent: number;
  volumeRecent: number;
}): {
  score: number;
  label: "Très faible" | "Faible" | "Modéré" | "Élevé" | "Très élevé";
  factors: string[];
} {
  let risk = 50;
  const factors: string[] = [];
  const trades = trader.tradesRecent;
  const volume = trader.volumeRecent;
  const averagePlacement = trader.averagePlacement ?? calculateAveragePlacement(volume, trades) ?? 0;

  if (trades >= 20) {
    risk -= 15;
    factors.push("Historique de trades solide");
  } else if (trades >= 10) {
    risk -= 10;
    factors.push("Nombre de trades correct");
  } else if (trades >= 5) {
    risk -= 5;
  } else if (trades < 3) {
    risk += 15;
    factors.push("Peu de trades observés");
  }

  if (volume >= 5_000) {
    risk -= 10;
    factors.push("Volume important");
  } else if (volume >= 1_000) {
    risk -= 5;
  } else if (volume < 100) {
    risk += 10;
    factors.push("Faible volume");
  }

  if (averagePlacement > 1_000) {
    risk += 15;
    factors.push("Placement moyen très élevé");
  } else if (averagePlacement > 500) {
    risk += 8;
    factors.push("Placement moyen élevé");
  } else if (averagePlacement >= 20 && averagePlacement <= 300) {
    risk -= 5;
    factors.push("Placement moyen raisonnable");
  } else if (averagePlacement > 0 && averagePlacement < 5) {
    risk += 5;
    factors.push("Placement moyen très faible");
  }

  const lastActivityMs = trader.lastActivity === null ? null : Date.parse(trader.lastActivity);
  if (lastActivityMs !== null && Number.isFinite(lastActivityMs)) {
    const ageSeconds = (Date.now() - lastActivityMs) / 1_000;

    if (ageSeconds < 60) {
      risk -= 10;
      factors.push("Activité très récente");
    } else if (ageSeconds < 300) {
      risk -= 5;
    } else if (ageSeconds > 3_600) {
      risk += 20;
      factors.push("Activité ancienne");
    } else if (ageSeconds > 900) {
      risk += 10;
    }
  } else {
    risk += 5;
    factors.push("Fraîcheur d’activité limitée");
  }

  if (trader.consistencyScore !== null) {
    if (trader.consistencyScore >= 80) {
      risk -= 15;
      factors.push("Bonne régularité");
    } else if (trader.consistencyScore >= 60) {
      risk -= 8;
    } else if (trader.consistencyScore < 30) {
      risk += 15;
      factors.push("Régularité faible");
    }
  } else {
    risk += 5;
    factors.push("Régularité partiellement mesurée");
  }

  if (trader.activityScore !== null) {
    if (trader.activityScore >= 80) {
      risk -= 10;
    } else if (trader.activityScore >= 50) {
      risk -= 5;
    } else if (trader.activityScore < 30) {
      risk += 10;
      factors.push("Activité faible");
    }
  }

  const marketConcentration = calculateMarketConcentration(trader.trades);
  if (marketConcentration !== null) {
    if (marketConcentration > 0.8) {
      risk += 15;
      factors.push("Forte concentration sur un marché");
    } else if (marketConcentration > 0.6) {
      risk += 8;
      factors.push("Concentration marché élevée");
    }
  } else {
    risk += 5;
    factors.push("Concentration marché partiellement mesurée");
  }

  const priceRisk = calculatePriceRisk(trader.trades, trader.price);
  risk += priceRisk.adjustment;
  factors.push(...priceRisk.factors);

  const score = clampScore(risk);
  return {
    score,
    label: riskLabel(score),
    factors: factors.slice(0, 6),
  };
}

function calculateIndicativeScore(
  activityScore: number | null,
  volumeScore: number | null,
  consistencyScore: number | null,
  tradeCount: number,
): number | null {
  const availableScores = [activityScore, volumeScore, consistencyScore].filter((score): score is number => score !== null);

  if (availableScores.length === 0) {
    return null;
  }

  const baseScore = availableScores.reduce((total, score) => total + score, 0) / availableScores.length;
  const singleTradePenalty = tradeCount === 1 && (volumeScore ?? 0) < 90 ? 0.65 : 1;

  return clampScore(baseScore * singleTradePenalty);
}

function calculateProfileQualityScore(scores: {
  indicativeScore: number | null;
  activityScore: number | null;
  volumeScore: number | null;
  consistencyScore: number | null;
  riskScore: number | null;
}): number | null {
  const weightedScores = [
    { score: scores.indicativeScore, weight: 35 },
    { score: scores.activityScore, weight: 20 },
    { score: scores.volumeScore, weight: 20 },
    { score: scores.consistencyScore, weight: 20 },
    { score: scores.riskScore, weight: 5 },
  ].filter((item): item is { score: number; weight: number } => item.score !== null);

  if (weightedScores.length === 0) {
    return null;
  }

  const totalWeight = weightedScores.reduce((total, item) => total + item.weight, 0);
  const weightedTotal = weightedScores.reduce((total, item) => total + item.score * item.weight, 0);

  return clampScore(weightedTotal / totalWeight);
}

function compareNullableScore(left: number | null, right: number | null): number {
  return (left ?? -1) - (right ?? -1);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function riskLabel(score: number): "Très faible" | "Faible" | "Modéré" | "Élevé" | "Très élevé" {
  if (score <= 20) {
    return "Très faible";
  }
  if (score <= 40) {
    return "Faible";
  }
  if (score <= 60) {
    return "Modéré";
  }
  if (score <= 80) {
    return "Élevé";
  }
  return "Très élevé";
}

function calculateMarketConcentration(trades: NormalizedTrade[]): number | null {
  const totalVolume = sumTradeVolume(trades);
  if (trades.length === 0 || totalVolume <= 0) {
    return null;
  }

  const grouped = new Map<string, number>();
  for (const trade of trades) {
    const key = trade.conditionId ?? trade.marketSlug ?? trade.marketTitle;
    if (key === null || trade.amount === null) {
      continue;
    }
    grouped.set(key, (grouped.get(key) ?? 0) + trade.amount);
  }

  if (grouped.size === 0) {
    return null;
  }

  return Math.max(...grouped.values()) / totalVolume;
}

function calculatePriceRisk(
  trades: NormalizedTrade[],
  fallbackPrice: number | null,
): {
  adjustment: number;
  factors: string[];
} {
  const prices = trades
    .map((trade) => normalizeProbability(trade.price))
    .filter((price): price is number => price !== null);
  const usablePrices = prices.length > 0 ? prices : [normalizeProbability(fallbackPrice)].filter((price): price is number => price !== null);

  if (usablePrices.length === 0) {
    return {
      adjustment: 5,
      factors: ["Prix d’entrée partiellement mesuré"],
    };
  }

  const extremeShare = usablePrices.filter((price) => price > 0.9 || price < 0.1).length / usablePrices.length;
  const balancedShare = usablePrices.filter((price) => price >= 0.35 && price <= 0.65).length / usablePrices.length;

  if (extremeShare >= 0.5) {
    return {
      adjustment: 8,
      factors: ["Prix d’entrée extrême"],
    };
  }

  if (balancedShare >= 0.5) {
    return {
      adjustment: -5,
      factors: [],
    };
  }

  return {
    adjustment: 0,
    factors: [],
  };
}

function normalizeProbability(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return value > 1 ? value / 100 : value;
}

function sumTradeVolume(trades: NormalizedTrade[]): number {
  return trades.reduce((total, trade) => total + (trade.amount ?? 0), 0);
}

function calculateAveragePlacement(volume: number | null, trades: number): number | null {
  if (volume === null || trades <= 0) {
    return null;
  }

  return volume / trades;
}

function calculateTraderGlobalScore(stats: {
  lastActivity: string | null;
  maxVolume: number;
  price: number | null;
  trades: NormalizedTrade[];
  tradesCount: number;
  volume: number;
}): TopTraderScores {
  const activityScore = stats.tradesCount > 0 ? clampScore(Math.log1p(stats.tradesCount) * 32) : 40;
  const volumeScore = stats.maxVolume > 0 ? clampScore((stats.volume / stats.maxVolume) * 100) : 40;
  const buckets = new Set(
    stats.trades
      .map((trade) => trade.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .map((timestamp) => Math.floor(timestamp / 300)),
  );
  const consistencyScore =
    stats.tradesCount > 0 && buckets.size > 0
      ? stats.tradesCount === 1
        ? 35
        : clampScore((buckets.size / Math.min(stats.tradesCount, 12)) * 100)
      : 40;
  const riskScore =
    stats.tradesCount > 0
      ? calculateTraderRisk({
          activityScore,
          averagePlacement: calculateAveragePlacement(stats.volume, stats.tradesCount),
          consistencyScore,
          lastActivity: stats.lastActivity,
          price: stats.price,
          trades: stats.trades,
          tradesRecent: stats.tradesCount,
          volumeRecent: stats.volume,
        }).score
      : 65;
  const inverseRiskScore = 100 - riskScore;
  const globalScore = clampScore(
    activityScore * 0.3 + volumeScore * 0.25 + consistencyScore * 0.25 + inverseRiskScore * 0.2,
  );

  return {
    activityScore,
    consistencyScore,
    globalScore,
    riskScore,
    volumeScore,
  };
}

function readMainMarket(trades: NormalizedTrade[]): { title: string; volume: number } {
  const grouped = new Map<string, { title: string; volume: number }>();

  for (const trade of trades) {
    const key = trade.conditionId ?? trade.marketSlug ?? trade.marketTitle;
    if (key === null) {
      continue;
    }

    const current = grouped.get(key);
    const volume = trade.amount ?? trade.size ?? 0;
    if (current === undefined) {
      grouped.set(key, {
        title: trade.marketTitle ?? "Public market",
        volume,
      });
      continue;
    }

    current.volume += volume;
  }

  return (
    Array.from(grouped.values()).sort((left, right) => right.volume - left.volume)[0] ?? {
      title: "Public market",
      volume: 0,
    }
  );
}

function countMarkets(trades: NormalizedTrade[]): number {
  return new Set(
    trades
      .map((trade) => trade.conditionId ?? trade.marketSlug ?? trade.marketTitle)
      .filter((value): value is string => value !== null),
  ).size;
}

function pruneMinuteWindow(values: number[], now: number) {
  const cutoff = now - 60_000;
  while (values[0] !== undefined && values[0] < cutoff) {
    values.shift();
  }
}

function secondsSince(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
}

function buildProfileUrl(wallet: string): string {
  return `https://polymarket.com/profile/${wallet}`;
}

function buildMarketUrl(slug: string | null): string | null {
  return slug === null ? null : `https://polymarket.com/event/${slug}`;
}

function testPolymarketWebSocket(assetIds: string[]) {
  return new Promise<{
    connected: boolean;
    subscribed: boolean;
    messageReceived: boolean;
    firstMessageType: string | null;
    latencyMs: number;
  }>((resolve, reject) => {
    const startedAt = Date.now();
    const ws = new WebSocket(POLYMARKET_WS_URL, {
      handshakeTimeout: POLYMARKET_WS_TIMEOUT_MS,
    });
    let settled = false;
    let connected = false;
    let subscribed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let openConfirmation: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      finish({
        connected,
        subscribed,
        messageReceived: false,
        firstMessageType: null,
        latencyMs: Date.now() - startedAt,
      });
    }, POLYMARKET_WS_TIMEOUT_MS);

    ws.once("open", () => {
      connected = true;
      subscribed = true;
      ws.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      openConfirmation = setTimeout(() => {
        finish({
          connected,
          subscribed,
          messageReceived: false,
          firstMessageType: null,
          latencyMs: Date.now() - startedAt,
        });
      }, Math.min(1_000, POLYMARKET_WS_TIMEOUT_MS));
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("PING");
        }
      }, 10_000);
    });

    ws.once("message", (rawMessage) => {
      finish({
        connected,
        subscribed,
        messageReceived: true,
        firstMessageType: readMessageType(rawMessage.toString()),
        latencyMs: Date.now() - startedAt,
      });
    });

    ws.once("error", (error) => {
      fail(error);
    });

    ws.once("close", (code, reason) => {
      if (!settled && !connected) {
        fail(new Error(`WebSocket closed before opening: ${code} ${reason.toString()}`.trim()));
      }
    });

    function finish(result: {
      connected: boolean;
      subscribed: boolean;
      messageReceived: boolean;
      firstMessageType: string | null;
      latencyMs: number;
    }) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (openConfirmation !== undefined) {
        clearTimeout(openConfirmation);
      }
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      safeCloseWebSocket(ws);
      resolve(result);
    }

    function fail(error: Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (openConfirmation !== undefined) {
        clearTimeout(openConfirmation);
      }
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      safeCloseWebSocket(ws);
      reject(error);
    }
  });
}

function extractPriceUpdates(payload: Record<string, unknown>, fallbackLatencyMs: number | null): LivePriceUpdate[] {
  const eventType = readString(payload.event_type) ?? readString(payload.type) ?? "unknown";
  const upstreamTimestamp = parseTimestamp(payload.timestamp);

  if (eventType === "price_change") {
    const priceChanges = Array.isArray(payload.price_changes) ? payload.price_changes : [];

    return priceChanges.flatMap((item) => {
      const change = asRecord(item);
      if (change === null) {
        return [];
      }

      const update = buildPriceUpdate(change, eventType, readString(payload.market), upstreamTimestamp, fallbackLatencyMs);
      return update === null ? [] : [update];
    });
  }

  const update = buildPriceUpdate(payload, eventType, readString(payload.market), upstreamTimestamp, fallbackLatencyMs);
  return update === null ? [] : [update];
}

function extractMarketLifecycleUpdate(payload: Record<string, unknown>): MarketLifecycleUpdate | null {
  const eventType = readString(payload.event_type) ?? readString(payload.type);
  if (eventType !== "market_resolved" && eventType !== "new_market") {
    return null;
  }

  return {
    type: "market_event",
    conditionId: readString(payload.condition_id) ?? readString(payload.conditionId),
    eventType,
    market: readString(payload.market) ?? readString(payload.slug),
    time: new Date().toISOString(),
    upstreamTimestamp: parseTimestamp(payload.timestamp),
  };
}

function buildPriceUpdate(
  payload: Record<string, unknown>,
  eventType: string,
  market: string | null,
  upstreamTimestamp: number | null,
  fallbackLatencyMs: number | null,
): LivePriceUpdate | null {
  const assetId = readString(payload.asset_id);
  if (assetId === null) {
    return null;
  }

  const bookBestBid = readBestPrice(payload.bids, "bid");
  const bookBestAsk = readBestPrice(payload.asks, "ask");
  const bestBid = parseNumber(payload.best_bid) ?? bookBestBid;
  const bestAsk = parseNumber(payload.best_ask) ?? bookBestAsk;
  const spread = parseNumber(payload.spread) ?? calculateSpread(bestBid, bestAsk);
  const price = parseNumber(payload.price) ?? calculateMidpoint(bestBid, bestAsk);
  const latencyMs = calculateTimestampLatency(upstreamTimestamp) ?? fallbackLatencyMs;

  return {
    type: "price",
    assetId,
    eventType,
    price,
    bestBid,
    bestAsk,
    spread,
    side: readString(payload.side),
    market,
    upstreamTimestamp,
    latencyMs,
    time: new Date().toISOString(),
  };
}

function extractCryptoPriceUpdates(payload: Record<string, unknown>, fallbackLatencyMs: number | null): LiveCryptoPriceUpdate[] {
  const singleUpdate = extractCryptoPriceUpdate(payload, fallbackLatencyMs);
  if (singleUpdate !== null) {
    return [singleUpdate];
  }

  const topic = readString(payload.topic);
  const payloadData = asRecord(payload.payload);
  if (payloadData === null) {
    return [];
  }

  const symbol = readString(payloadData.symbol);
  const snapshotData = Array.isArray(payloadData.data) ? payloadData.data : [];
  if (symbol === null || snapshotData.length === 0) {
    return [];
  }

  const source = resolveCryptoPriceSource(topic, symbol);
  const updates: LiveCryptoPriceUpdate[] = [];
  for (const point of snapshotData) {
    const pointRecord = asRecord(point);
    if (pointRecord === null) {
      continue;
    }

    const price = parseNumber(pointRecord.value);
    if (price === null) {
      continue;
    }

    const upstreamTimestamp = parseTimestamp(pointRecord.timestamp ?? payload.timestamp);
    updates.push({
      type: "crypto_price",
      latencyMs: calculateTimestampLatency(upstreamTimestamp) ?? fallbackLatencyMs,
      price,
      source,
      symbol,
      time: new Date().toISOString(),
      upstreamTimestamp,
    });
  }

  return updates;
}

function extractCryptoPriceUpdate(payload: Record<string, unknown>, fallbackLatencyMs: number | null): LiveCryptoPriceUpdate | null {
  const topic = readString(payload.topic);
  const payloadData = asRecord(payload.payload);
  if (payloadData === null) {
    return null;
  }

  const symbol = readString(payloadData.symbol);
  const price = parseNumber(payloadData.value);
  if (symbol === null || price === null) {
    return null;
  }

  const upstreamTimestamp = parseTimestamp(payloadData.timestamp ?? payload.timestamp);
  const latencyMs = calculateTimestampLatency(upstreamTimestamp) ?? fallbackLatencyMs;
  const source = resolveCryptoPriceSource(topic, symbol);

  return {
    type: "crypto_price",
    latencyMs,
    price,
    source,
    symbol,
    time: new Date().toISOString(),
    upstreamTimestamp,
  };
}

function resolveCryptoPriceSource(topic: string | null, symbol: string): "chainlink" | "binance" {
  if (topic === "crypto_prices_chainlink" || symbol.includes("/")) {
    return "chainlink";
  }

  return "binance";
}

function rememberCryptoPrice(update: LiveCryptoPriceUpdate) {
  if (update.upstreamTimestamp === null || !Number.isFinite(update.price)) {
    return;
  }

  const symbol = update.symbol.toLowerCase();
  const history = cryptoPriceHistory.get(symbol) ?? [];
  history.push({
    price: update.price,
    timestamp: update.upstreamTimestamp,
  });

  const deduped = new Map<number, { price: number; timestamp: number }>();
  for (const point of history) {
    deduped.set(point.timestamp, point);
  }

  cryptoPriceHistory.set(
    symbol,
    Array.from(deduped.values())
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-CRYPTO_PRICE_HISTORY_LIMIT),
  );
}

function setupStaticFrontend() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.join(currentDir, "client");
  const frontendIndex = path.join(frontendDir, "index.html");

  if (!existsSync(frontendIndex)) {
    return;
  }

  app.use(express.static(frontendDir));
  app.get("/{*splat}", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/api/") || req.path.startsWith("/ws/")) {
      next();
      return;
    }

    res.sendFile(frontendIndex);
  });
}

function parsePayloads(message: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(message) as unknown;
    return flattenPayloads(parsed);
  } catch {
    return [];
  }
}

function flattenPayloads(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenPayloads);
  }

  const record = asRecord(value);
  return record === null ? [] : [record];
}

function readBestPrice(value: unknown, side: "bid" | "ask"): number | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const prices = value
    .map((item) => asRecord(item))
    .map((item) => (item === null ? null : parseNumber(item.price)))
    .filter((price): price is number => price !== null);

  if (prices.length === 0) {
    return null;
  }

  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

function calculateMidpoint(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function calculateSpread(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return Math.max(0, bestAsk - bestBid);
}

function calculateTimestampLatency(timestamp: number | null): number | null {
  if (timestamp === null) {
    return null;
  }

  const latencyMs = Date.now() - timestamp;
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 86_400_000) {
    return null;
  }

  return latencyMs;
}

function parseTimestamp(value: unknown): number | null {
  const timestamp = parseNumber(value);
  if (timestamp === null) {
    return null;
  }

  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

function readAssetIds(message: ClientMessage): string[] {
  const rawAssetIds = Array.isArray(message.assetIds)
    ? message.assetIds
    : Array.isArray(message.assets_ids)
      ? message.assets_ids
      : [];

  const assetIds = rawAssetIds
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  return Array.from(new Set(assetIds)).slice(0, MAX_WS_ASSET_IDS);
}

function readCryptoSymbol(value: unknown, fallback: string): string {
  const rawValue = readQueryString(value);
  const normalizedValue = rawValue === null ? null : rawValue.toLowerCase();
  if (normalizedValue === null || !/^[a-z]{2,8}(\/usd|usdt)$/.test(normalizedValue)) {
    return fallback;
  }

  return normalizedValue;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOpeningScenarioSettings(value: unknown):
  | { ok: true; settings: OpeningScenarioSettings }
  | { ok: false; error: string } {
  const record = asRecord(value);
  if (record === null) {
    return { error: "Invalid JSON body.", ok: false };
  }

  const next: OpeningScenarioSettings = {
    ...openingScenarioSettings,
    allowedAssets: readOpeningAssets(record.allowedAssets, openingScenarioSettings.allowedAssets),
    doNotForceUnclearBecauseNearTargetAtOpen:
      typeof record.doNotForceUnclearBecauseNearTargetAtOpen === "boolean"
        ? record.doNotForceUnclearBecauseNearTargetAtOpen
        : openingScenarioSettings.doNotForceUnclearBecauseNearTargetAtOpen,
    enabled: typeof record.enabled === "boolean" ? record.enabled : openingScenarioSettings.enabled,
    entryDelayMs: readRange(record.entryDelayMs, 0, 5_000, openingScenarioSettings.entryDelayMs),
    entryMode: readOpeningEntryMode(record.entryMode, openingScenarioSettings.entryMode),
    entryWindowSeconds: readRange(record.entryWindowSeconds, 1, 30, openingScenarioSettings.entryWindowSeconds),
    maxOpeningStakeUsd: readNonNegative(record.maxOpeningStakeUsd, openingScenarioSettings.maxOpeningStakeUsd),
    maxSpreadPercent: readRange(record.maxSpreadPercent, 1, 10, openingScenarioSettings.maxSpreadPercent),
    minConfidenceForOpeningEntry: readRange(record.minConfidenceForOpeningEntry, 0.5, 0.8, openingScenarioSettings.minConfidenceForOpeningEntry),
    minEdgeNetForOpeningEntry: readRange(record.minEdgeNetForOpeningEntry, 0, 0.2, openingScenarioSettings.minEdgeNetForOpeningEntry),
    minLiquidityScore: readRange(record.minLiquidityScore, 0, 100, openingScenarioSettings.minLiquidityScore),
    minStakeUsd: readNonNegative(record.minStakeUsd, openingScenarioSettings.minStakeUsd),
    nearTargetAtOpenIsAllowed:
      typeof record.nearTargetAtOpenIsAllowed === "boolean" ? record.nearTargetAtOpenIsAllowed : openingScenarioSettings.nearTargetAtOpenIsAllowed,
    openAtMarketStart: typeof record.openAtMarketStart === "boolean" ? record.openAtMarketStart : openingScenarioSettings.openAtMarketStart,
    smartScalingAfterOpening:
      typeof record.smartScalingAfterOpening === "boolean" ? record.smartScalingAfterOpening : openingScenarioSettings.smartScalingAfterOpening,
    usePreOpenBiasWhenNearTarget:
      typeof record.usePreOpenBiasWhenNearTarget === "boolean" ? record.usePreOpenBiasWhenNearTarget : openingScenarioSettings.usePreOpenBiasWhenNearTarget,
  };

  if (next.maxOpeningStakeUsd < next.minStakeUsd) {
    return { error: "maxOpeningStakeUsd must be greater than or equal to minStakeUsd.", ok: false };
  }

  return { ok: true, settings: next };
}

function readRange(value: unknown, min: number, max: number, fallback: number) {
  const parsed = parseNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readNonNegative(value: unknown, fallback: number) {
  const parsed = parseNumber(value);
  return parsed === null ? fallback : Math.max(0, parsed);
}

function readOpeningEntryMode(value: unknown, fallback: OpeningEntryMode): OpeningEntryMode {
  return value === "OFF" || value === "IF_APPROVED" || value === "FORCED_PAPER_ONLY" || value === "FORCED_MIN_STAKE_PAPER"
    ? value
    : fallback;
}

function readOpeningAssets(value: unknown, fallback: OpeningScenarioSettings["allowedAssets"]) {
  const allowed = new Set(DEFAULT_OPENING_SCENARIO_SETTINGS.allowedAssets);
  const values = readStringArray(value).filter((item): item is OpeningScenarioSettings["allowedAssets"][number] =>
    allowed.has(item as OpeningScenarioSettings["allowedAssets"][number]),
  );
  return values.length === 0 ? fallback : Array.from(new Set(values));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readMessageType(message: string): string | null {
  if (message === "PONG") {
    return "PONG";
  }

  const payload = parsePayloads(message)[0];
  if (payload === undefined) {
    return null;
  }

  return readString(payload.event_type) ?? readString(payload.type);
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a valid number.`);
  }

  return value;
}

function readLimit(value: unknown, fallback: number, max = 50): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = parseNumber(rawValue);

  if (parsed === null) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function readPeriod(value: unknown, fallback: PeriodKey = "15m"): PeriodKey {
  const rawValue = readQueryString(value);

  if (rawValue !== null && rawValue in PERIOD_SECONDS) {
    return rawValue as PeriodKey;
  }

  return fallback;
}

function readTraderSort(value: unknown): TraderSort {
  const rawValue = readQueryString(value);

  if (
    rawValue === "profile_quality" ||
    rawValue === "indicative_score" ||
    rawValue === "activity" ||
    rawValue === "volume" ||
    rawValue === "consistency" ||
    rawValue === "risk" ||
    rawValue === "last_activity" ||
    rawValue === "trades" ||
    rawValue === "average_placement"
  ) {
    return rawValue;
  }

  return "profile_quality";
}

function readTopTraderPeriod(value: unknown): TopTraderPeriod {
  const rawValue = readQueryString(value)?.toLowerCase();

  if (
    rawValue === "10m" ||
    rawValue === "30m" ||
    rawValue === "1h" ||
    rawValue === "4h" ||
    rawValue === "day" ||
    rawValue === "week" ||
    rawValue === "all"
  ) {
    return rawValue;
  }

  return "10m";
}

function readTopTraderSort(value: unknown): TopTraderSort {
  const rawValue = readQueryString(value);

  if (rawValue === "pnl" || rawValue === "volume" || rawValue === "activity" || rawValue === "globalScore") {
    return rawValue;
  }

  return "globalScore";
}

function isLeaderboardPeriod(period: TopTraderPeriod): period is "day" | "week" | "all" {
  return period === "day" || period === "week" || period === "all";
}

function toLeaderboardTimePeriod(period: "day" | "week" | "all"): LeaderboardTimePeriod {
  if (period === "day") {
    return "DAY";
  }
  if (period === "week") {
    return "WEEK";
  }
  return "ALL";
}

function readPriceHistoryInterval(value: unknown): "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h" {
  const rawValue = readQueryString(value);
  if (
    rawValue === "max" ||
    rawValue === "all" ||
    rawValue === "1m" ||
    rawValue === "1w" ||
    rawValue === "1d" ||
    rawValue === "6h" ||
    rawValue === "1h"
  ) {
    return rawValue;
  }

  return "6h";
}

function readUnixTimestamp(value: unknown): number | null {
  const parsed = parseNumber(Array.isArray(value) ? value[0] : value);
  return parsed === null ? null : Math.trunc(parsed);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = parseNumber(Array.isArray(value) ? value[0] : value);
  if (parsed === null || parsed <= 0) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function readMinimumNumber(value: unknown): number | null {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = parseNumber(rawValue);

  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed;
}

function readQueryString(value: unknown): string | null {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return readString(rawValue);
}

function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sendClient(client: WebSocket, message: Record<string, unknown>) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function sendClientError(client: WebSocket, message: string) {
  sendClient(client, {
    type: "error",
    message,
    time: new Date().toISOString(),
  });
}

function sendError(res: Response, message: string, error: unknown) {
  res.status(502).json({
    ok: false,
    appName: APP_NAME,
    mode: MODE,
    message,
    error: error instanceof Error ? error.message : String(error),
    time: new Date().toISOString(),
  });
}
