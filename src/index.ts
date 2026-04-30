import "dotenv/config";

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const APP_NAME = "BLACK-GOAT";
const MODE = (process.env.MODE ?? "TEST").toUpperCase();
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = readNumberEnv("PORT", 4000);
const POLYMARKET_MARKET_LIMIT = readNumberEnv("POLYMARKET_MARKET_LIMIT", 8);
const POLYMARKET_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com",
);
const POLYMARKET_DATA_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_DATA_API_BASE ?? "https://data-api.polymarket.com",
);
const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLYMARKET_REQUEST_TIMEOUT_MS = readNumberEnv("POLYMARKET_REQUEST_TIMEOUT_MS", 10_000);
const POLYMARKET_WS_TIMEOUT_MS = readNumberEnv("POLYMARKET_WS_TIMEOUT_MS", 10_000);
const POLYMARKET_TRADES_FETCH_LIMIT = readNumberEnv("POLYMARKET_TRADES_FETCH_LIMIT", 500);
const POLYMARKET_TRADES_POLL_MS = readNumberEnv("POLYMARKET_TRADES_POLL_MS", 5_000);
const CLIENT_WS_PATH = "/ws/polymarket";
const TRADERS_WS_PATH = "/ws/traders";
const MAX_WS_ASSET_IDS = 80;
const DATA_SOURCE_REAL = "REAL POLYMARKET DATA";
const DATA_SOURCE_UNAVAILABLE = "UNAVAILABLE";

const PERIOD_SECONDS = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

if (MODE !== "TEST") {
  throw new Error("BLACK-GOAT only supports MODE=TEST for this read-only viewer.");
}

type GammaMarket = {
  id?: string | number;
  question?: string;
  slug?: string;
  outcomes?: unknown;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
  volume24hr?: string | number;
  liquidity?: string | number;
  liquidityNum?: string | number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
};

type PublicMarket = {
  id: string | null;
  question: string | null;
  slug: string | null;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  volume24hr: number | null;
  liquidity: number | null;
  endDate: string | null;
  active: boolean | null;
  closed: boolean | null;
  acceptingOrders: boolean | null;
};

type FetchJsonResult<T> = {
  data: T;
  endpoint: string;
  latencyMs: number;
  status: number;
};

type PeriodKey = keyof typeof PERIOD_SECONDS;
type DataSourceStatus = typeof DATA_SOURCE_REAL | typeof DATA_SOURCE_UNAVAILABLE;

type ClientMessage = {
  type?: unknown;
  assetIds?: unknown;
  assets_ids?: unknown;
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
  profileUrl: string | null;
  marketUrl: string | null;
  dataSourceStatus: DataSourceStatus;
};

type TraderScores = {
  activityScore: number | null;
  volumeScore: number | null;
  consistencyScore: number | null;
  riskPlaceholder: null;
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
  profileUrl: string;
  dataSourceStatus: DataSourceStatus;
  scores: TraderScores;
};

const app = express();
const server = createServer(app);
const clientWss = new WebSocketServer({ noServer: true });
const tradersWss = new WebSocketServer({ noServer: true });

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

app.get("/api/polymarket/status", async (_req, res) => {
  try {
    const result = await fetchPolymarketMarkets(1);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      api: "Polymarket Gamma",
      endpoint: result.endpoint,
      status: result.status,
      latencyMs: result.latencyMs,
      marketCount: result.data.length,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket public API request failed.", error);
  }
});

app.get("/api/polymarket/markets", async (req, res) => {
  try {
    const limit = readLimit(req.query.limit, POLYMARKET_MARKET_LIMIT);
    const result = await fetchPolymarketMarkets(limit);
    const markets = result.data.map(normalizeMarket);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      endpoint: result.endpoint,
      count: markets.length,
      markets,
      time: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, "Polymarket markets request failed.", error);
  }
});

app.get("/api/polymarket/ws-test", async (_req, res) => {
  try {
    const marketResult = await fetchPolymarketMarkets(1);
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
    const limit = readLimit(req.query.limit, 50, 100);
    const result = await fetchDataApiTrades(POLYMARKET_TRADES_FETCH_LIMIT);
    const trades = filterTradesByPeriod(result.data.map(normalizeTrade), period);
    const traders = buildActiveTraders(trades, sort, search).slice(0, limit);

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: DATA_SOURCE_REAL,
      source: result.endpoint,
      period,
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
    const marketsMostTraded = buildMostTradedMarkets(recentTrades);
    const lastTrade = recentTrades[0] ?? allTrades[0] ?? null;
    const dataInsufficient = allTrades.length === 0;

    res.json({
      ok: true,
      appName: APP_NAME,
      mode: MODE,
      dataSourceStatus: dataInsufficient ? DATA_SOURCE_UNAVAILABLE : DATA_SOURCE_REAL,
      profileDataSourceStatus: profileResult.dataSourceStatus,
      trader: {
        wallet,
        username: profile.username ?? lastTrade?.username ?? null,
        pseudonym: profile.pseudonym ?? lastTrade?.pseudonym ?? null,
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
            tradesRecent: 0,
            lastActivity: null,
            activityRecent: null,
            scores: emptyScores(),
          }
        : {
            message: null,
            period,
            volumeRecent,
            tradesRecent: recentTrades.length,
            lastActivity: lastTrade?.time ?? null,
            activityRecent: recentTrades.length > 0 ? "REAL POLYMARKET DATA" : DATA_SOURCE_UNAVAILABLE,
            scores: calculateScores(recentTrades, volumeRecent, volumeRecent),
          },
      latestTrades: recentTrades.slice(0, 50),
      marketsMostTraded,
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

setupStaticFrontend();
setupClientWebSocket();

server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} ${MODE} listening on http://${HOST}:${PORT}`);
});

async function fetchPolymarketMarkets(limit: number): Promise<FetchJsonResult<GammaMarket[]>> {
  const url = new URL("/markets", POLYMARKET_API_BASE);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", String(limit));

  return fetchJson<GammaMarket[]>(url);
}

async function fetchDataApiTrades(limit: number, user?: string): Promise<FetchJsonResult<DataApiTrade[]>> {
  const url = new URL("/trades", POLYMARKET_DATA_API_BASE);
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit), 1), 10_000)));
  url.searchParams.set("takerOnly", "false");

  if (user !== undefined) {
    url.searchParams.set("user", user);
  }

  return fetchJson<DataApiTrade[]>(url);
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

    if (pathname === TRADERS_WS_PATH) {
      tradersWss.handleUpgrade(request, socket, head, (client) => {
        tradersWss.emit("connection", client, request);
        attachTradersRelay(client, readPeriod(url.searchParams.get("period")));
      });
      return;
    }

      socket.destroy();
  });

  clientWss.on("connection", (client) => {
    attachPolymarketRelay(client);
  });
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
      upstream.close();
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

function attachTradersRelay(client: WebSocket, period: PeriodKey) {
  let closed = false;
  let polling = false;
  let snapshotSent = false;
  let timer: NodeJS.Timeout | undefined;
  const seenTradeIds = new Set<string>();

  sendClient(client, {
    type: "status",
    status: "OFFLINE",
    dataSourceStatus: DATA_SOURCE_UNAVAILABLE,
    transport: "POLLING_PUBLIC_DATA_API",
    message: "Waiting for first public trades poll.",
    period,
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
      const trades = filterTradesByPeriod(result.data.map(normalizeTrade), period).slice(0, 50);
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
      sendClient(client, {
        type: "status",
        status: "LIVE",
        dataSourceStatus: DATA_SOURCE_REAL,
        transport: "POLLING_PUBLIC_DATA_API",
        latencyMs: Date.now() - startedAt,
        period,
        time: new Date().toISOString(),
      });

      if (payloadTrades.length > 0) {
        sendClient(client, {
          type: "trades",
          snapshot: isSnapshot,
          dataSourceStatus: DATA_SOURCE_REAL,
          period,
          count: payloadTrades.length,
          trades: payloadTrades,
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
        period,
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
    outcomes: parseStringArray(market.outcomes),
    outcomePrices: parseStringArray(market.outcomePrices),
    clobTokenIds: parseStringArray(market.clobTokenIds),
    volume24hr: parseNumber(market.volume24hr),
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    endDate: market.endDate ?? null,
    active: market.active ?? null,
    closed: market.closed ?? null,
    acceptingOrders: market.acceptingOrders ?? null,
  };
}

function normalizeTrade(trade: DataApiTrade): NormalizedTrade {
  const wallet = readString(trade.proxyWallet);
  const username = readString(trade.name);
  const pseudonym = readString(trade.pseudonym);
  const size = parseNumber(trade.size);
  const price = parseNumber(trade.price);
  const amount = size === null || price === null ? null : size * price;
  const timestampMs = parseTimestamp(trade.timestamp);
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

function buildActiveTraders(
  trades: NormalizedTrade[],
  sort: "volume" | "trades" | "activity",
  search: string | null,
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
  const normalizedSearch = search?.toLowerCase() ?? null;
  const traders = Array.from(grouped.values()).map((item) => ({
    id: item.wallet,
    wallet: item.wallet,
    username: item.username,
    pseudonym: item.pseudonym,
    volumeRecent: item.volumeRecent,
    tradesRecent: item.trades.length,
    lastActivity: item.lastTrade.time,
    market: item.lastTrade.marketTitle,
    outcome: item.lastTrade.outcome,
    price: item.lastTrade.price,
    amount: item.lastTrade.amount,
    profileUrl: buildProfileUrl(item.wallet),
    dataSourceStatus: DATA_SOURCE_REAL as DataSourceStatus,
    scores: calculateScores(item.trades, item.volumeRecent, maxVolume),
  }));

  const filtered = normalizedSearch === null
    ? traders
    : traders.filter((trader) =>
        [trader.wallet, trader.username, trader.pseudonym]
          .filter((value): value is string => value !== null)
          .some((value) => value.toLowerCase().includes(normalizedSearch)),
      );

  return filtered.sort((left, right) => {
    if (sort === "trades") {
      return right.tradesRecent - left.tradesRecent;
    }

    if (sort === "activity") {
      return new Date(right.lastActivity ?? 0).getTime() - new Date(left.lastActivity ?? 0).getTime();
    }

    return right.volumeRecent - left.volumeRecent;
  });
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

function calculateScores(trades: NormalizedTrade[], volume: number, maxVolume: number): TraderScores {
  if (trades.length === 0) {
    return emptyScores();
  }

  const activityScore = clampScore(trades.length * 8);
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
        ? 20
        : clampScore((timestampBuckets.size / Math.min(trades.length, 12)) * 100);
  const availableScores = [activityScore, volumeScore, consistencyScore].filter(
    (score): score is number => score !== null,
  );
  const overallScore =
    availableScores.length === 0
      ? null
      : Math.round(availableScores.reduce((total, score) => total + score, 0) / availableScores.length);

  return {
    activityScore,
    volumeScore,
    consistencyScore,
    riskPlaceholder: null,
    overallScore,
    disclaimer: "Score analytique indicatif en lecture seule, pas un conseil financier.",
  };
}

function emptyScores(): TraderScores {
  return {
    activityScore: null,
    volumeScore: null,
    consistencyScore: null,
    riskPlaceholder: null,
    overallScore: null,
    disclaimer: "Score analytique indicatif en lecture seule, pas un conseil financier.",
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sumTradeVolume(trades: NormalizedTrade[]): number {
  return trades.reduce((total, trade) => total + (trade.amount ?? 0), 0);
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
      ws.close();
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
      ws.close();
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

function parseNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function readTraderSort(value: unknown): "volume" | "trades" | "activity" {
  const rawValue = readQueryString(value);

  if (rawValue === "trades" || rawValue === "activity") {
    return rawValue;
  }

  return "volume";
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
