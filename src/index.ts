import "dotenv/config";

import express, { type Response } from "express";
import WebSocket from "ws";

const APP_NAME = "BLACK-GOAT";
const MODE = (process.env.MODE ?? "TEST").toUpperCase();
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = readNumberEnv("PORT", 4000);
const POLYMARKET_API_BASE = stripTrailingSlash(
  process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com",
);
const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLYMARKET_REQUEST_TIMEOUT_MS = readNumberEnv("POLYMARKET_REQUEST_TIMEOUT_MS", 10_000);
const POLYMARKET_WS_TIMEOUT_MS = readNumberEnv("POLYMARKET_WS_TIMEOUT_MS", 10_000);

if (MODE !== "TEST") {
  throw new Error("BLACK-GOAT step 1 only supports MODE=TEST.");
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

const app = express();

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

app.get("/api/polymarket/markets", async (_req, res) => {
  try {
    const result = await fetchPolymarketMarkets(5);
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

app.listen(PORT, HOST, () => {
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
      "user-agent": `${APP_NAME}/0.1.0 TEST`,
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

function readMessageType(message: string): string | null {
  if (message === "PONG") {
    return "PONG";
  }

  try {
    const parsed = JSON.parse(message) as { event_type?: unknown; type?: unknown };
    const messageType = parsed.event_type ?? parsed.type;
    return typeof messageType === "string" ? messageType : null;
  } catch {
    return null;
  }
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

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
