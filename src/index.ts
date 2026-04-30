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
const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLYMARKET_REQUEST_TIMEOUT_MS = readNumberEnv("POLYMARKET_REQUEST_TIMEOUT_MS", 10_000);
const POLYMARKET_WS_TIMEOUT_MS = readNumberEnv("POLYMARKET_WS_TIMEOUT_MS", 10_000);
const CLIENT_WS_PATH = "/ws/polymarket";
const MAX_WS_ASSET_IDS = 80;

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

const app = express();
const server = createServer(app);
const clientWss = new WebSocketServer({ noServer: true });

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
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;

    if (pathname !== CLIENT_WS_PATH) {
      socket.destroy();
      return;
    }

    clientWss.handleUpgrade(request, socket, head, (client) => {
      clientWss.emit("connection", client, request);
    });
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

function readLimit(value: unknown, fallback: number): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = parseNumber(rawValue);

  if (parsed === null) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
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
