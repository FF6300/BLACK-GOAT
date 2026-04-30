import { useCallback, useEffect, useMemo, useState } from "react";

type MarketResponse = {
  ok: boolean;
  count: number;
  markets: PublicMarket[];
  time: string;
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

type LivePrice = {
  assetId: string;
  eventType: string;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  side: string | null;
  latencyMs: number | null;
  time: string;
};

type LiveStatus = "CONNECTING" | "LIVE" | "OFFLINE";

type ServerMessage = {
  type?: unknown;
  status?: unknown;
  latencyMs?: unknown;
  message?: unknown;
  assetId?: unknown;
  eventType?: unknown;
  price?: unknown;
  bestBid?: unknown;
  bestAsk?: unknown;
  spread?: unknown;
  side?: unknown;
  time?: unknown;
};

export default function App() {
  const [markets, setMarkets] = useState<PublicMarket[]>([]);
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [status, setStatus] = useState<LiveStatus>("CONNECTING");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const assetIds = useMemo(
    () => Array.from(new Set(markets.flatMap((market) => market.clobTokenIds))).slice(0, 80),
    [markets],
  );

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/polymarket/markets?limit=8");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as MarketResponse;
      setMarkets(payload.markets ?? []);
      setLastUpdate(payload.time);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setStatus("OFFLINE");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  useEffect(() => {
    if (assetIds.length === 0) {
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) {
        return;
      }

      setStatus("CONNECTING");
      socket = new WebSocket(buildWebSocketUrl());

      socket.addEventListener("open", () => {
        socket?.send(
          JSON.stringify({
            type: "subscribe",
            assetIds,
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (message === null) {
          return;
        }

        if (message.type === "status") {
          const nextStatus = message.status === "LIVE" ? "LIVE" : "OFFLINE";
          setStatus(nextStatus);
          setLatencyMs(readNumber(message.latencyMs));
          setLastUpdate(readString(message.time) ?? new Date().toISOString());
          return;
        }

        if (message.type === "price") {
          const price = normalizeLivePrice(message);
          if (price === null) {
            return;
          }

          setPrices((current) => ({
            ...current,
            [price.assetId]: price,
          }));
          setLatencyMs(price.latencyMs);
          setLastUpdate(price.time);
          setStatus("LIVE");
          return;
        }

        if (message.type === "error") {
          setError(readString(message.message) ?? "WebSocket error");
          setStatus("OFFLINE");
        }
      });

      socket.addEventListener("close", () => {
        setStatus("OFFLINE");

        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 3_000);
        }
      });

      socket.addEventListener("error", () => {
        setStatus("OFFLINE");
      });
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [assetIds]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">BLACK-GOAT</p>
          <h1>Polymarket live viewer</h1>
        </div>
        <div className="status-panel">
          <span className={`status-dot ${status.toLowerCase()}`} />
          <span className="status-label">{status}</span>
          <span className="latency">{formatLatency(latencyMs)}</span>
        </div>
      </header>

      <section className="summary" aria-label="Market status">
        <div>
          <span className="metric-label">Markets</span>
          <strong>{loading ? "..." : markets.length}</strong>
        </div>
        <div>
          <span className="metric-label">Assets</span>
          <strong>{assetIds.length}</strong>
        </div>
        <div>
          <span className="metric-label">Last update</span>
          <strong>{formatTime(lastUpdate)}</strong>
        </div>
        <button type="button" onClick={() => void loadMarkets()}>
          Refresh
        </button>
      </section>

      {error !== null ? <p className="error">{error}</p> : null}

      <section className="market-list" aria-label="Markets">
        {loading ? <p className="empty">Loading markets...</p> : null}
        {!loading && markets.length === 0 ? <p className="empty">No markets returned.</p> : null}
        {markets.map((market, index) => (
          <MarketRow key={market.id ?? market.slug ?? market.question ?? index} market={market} prices={prices} />
        ))}
      </section>
    </main>
  );
}

function MarketRow({ market, prices }: { market: PublicMarket; prices: Record<string, LivePrice> }) {
  return (
    <article className="market-card">
      <div className="market-main">
        <div>
          <h2>{market.question ?? "Untitled market"}</h2>
          <div className="market-meta">
            <span>Vol 24h {formatUsd(market.volume24hr)}</span>
            <span>Liquidity {formatUsd(market.liquidity)}</span>
            <span>{market.acceptingOrders ? "Orders open" : "Read only"}</span>
          </div>
        </div>
        {market.slug !== null ? (
          <a href={`https://polymarket.com/event/${market.slug}`} target="_blank" rel="noreferrer">
            Open
          </a>
        ) : null}
      </div>

      <div className="outcome-grid">
        {market.outcomes.map((outcome, index) => {
          const assetId = market.clobTokenIds[index] ?? "";
          const livePrice = assetId.length > 0 ? prices[assetId] : undefined;
          const initialPrice = readNumber(market.outcomePrices[index]);
          const displayPrice = livePrice?.price ?? calculateMidpoint(livePrice?.bestBid ?? null, livePrice?.bestAsk ?? null) ?? initialPrice;

          return (
            <div className="outcome" key={`${assetId}-${outcome}`}>
              <div className="outcome-head">
                <span>{outcome}</span>
                <strong>{formatProbability(displayPrice)}</strong>
              </div>
              <div className="price-line">
                <span>Bid {formatProbability(livePrice?.bestBid ?? null)}</span>
                <span>Ask {formatProbability(livePrice?.bestAsk ?? null)}</span>
                <span>{livePrice?.eventType ?? "snapshot"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function buildWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/polymarket`;
}

function parseServerMessage(value: unknown): ServerMessage | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeLivePrice(message: ServerMessage): LivePrice | null {
  const assetId = readString(message.assetId);
  if (assetId === null) {
    return null;
  }

  return {
    assetId,
    eventType: readString(message.eventType) ?? "price",
    price: readNumber(message.price),
    bestBid: readNumber(message.bestBid),
    bestAsk: readNumber(message.bestAsk),
    spread: readNumber(message.spread),
    side: readString(message.side),
    latencyMs: readNumber(message.latencyMs),
    time: readString(message.time) ?? new Date().toISOString(),
  };
}

function calculateMidpoint(bestBid: number | null, bestAsk: number | null) {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function formatProbability(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  const digits = value > 0 && value < 0.01 ? 2 : 1;
  return `${(value * 100).toFixed(digits)}%`;
}

function formatLatency(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "latency --";
  }

  return `${Math.round(value)} ms`;
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatTime(value: string | null) {
  if (value === null) {
    return "--";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
