import { useCallback, useEffect, useMemo, useState } from "react";

type DataSourceStatus = "REAL POLYMARKET DATA" | "UNAVAILABLE";
type LiveStatus = "CONNECTING" | "LIVE" | "OFFLINE";
type Tab = "markets" | "traders";
type PeriodKey = "5m" | "15m" | "1h" | "4h" | "24h";
type TraderSort = "volume" | "trades" | "activity";

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
  amountSource: string;
  timestamp: number | null;
  time: string | null;
  transactionHash: string | null;
  profileUrl: string | null;
  marketUrl: string | null;
  dataSourceStatus: DataSourceStatus;
};

type ActiveTradersResponse = {
  ok: boolean;
  dataSourceStatus: DataSourceStatus;
  period: PeriodKey;
  count: number;
  traders: ActiveTrader[];
  time: string;
};

type LiveTradesResponse = {
  ok: boolean;
  dataSourceStatus: DataSourceStatus;
  period: PeriodKey;
  count: number;
  trades: NormalizedTrade[];
  time: string;
};

type TraderProfileResponse = {
  ok: boolean;
  dataSourceStatus: DataSourceStatus;
  profileDataSourceStatus: DataSourceStatus;
  trader: {
    wallet: string;
    username: string | null;
    pseudonym: string | null;
    bio: string | null;
    profileImage: string | null;
    xUsername: string | null;
    verifiedBadge: boolean | null;
    createdAt: string | null;
    profileUrl: string;
  };
  summary: {
    message: string | null;
    period?: PeriodKey;
    volumeRecent: number | null;
    tradesRecent: number;
    lastActivity: string | null;
    activityRecent: string | null;
    scores: TraderScores;
  };
  latestTrades: NormalizedTrade[];
  marketsMostTraded: Array<{
    conditionId: string | null;
    marketTitle: string | null;
    marketSlug: string | null;
    marketUrl: string | null;
    trades: number;
    volume: number;
    lastActivity: string | null;
  }>;
  time: string;
};

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
  trades?: unknown;
  dataSourceStatus?: unknown;
};

const PERIODS: PeriodKey[] = ["5m", "15m", "1h", "4h", "24h"];

export default function App() {
  const [tab, setTab] = useState<Tab>("markets");
  const [markets, setMarkets] = useState<PublicMarket[]>([]);
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [marketStatus, setMarketStatus] = useState<LiveStatus>("CONNECTING");
  const [marketLatencyMs, setMarketLatencyMs] = useState<number | null>(null);
  const [marketLastUpdate, setMarketLastUpdate] = useState<string | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [period, setPeriod] = useState<PeriodKey>("15m");
  const [sort, setSort] = useState<TraderSort>("volume");
  const [search, setSearch] = useState("");
  const [traders, setTraders] = useState<ActiveTrader[]>([]);
  const [liveTrades, setLiveTrades] = useState<NormalizedTrade[]>([]);
  const [tradersStatus, setTradersStatus] = useState<LiveStatus>("CONNECTING");
  const [tradersLatencyMs, setTradersLatencyMs] = useState<number | null>(null);
  const [tradersDataStatus, setTradersDataStatus] = useState<DataSourceStatus>("UNAVAILABLE");
  const [tradersLastUpdate, setTradersLastUpdate] = useState<string | null>(null);
  const [tradersLoading, setTradersLoading] = useState(true);
  const [selectedTraderId, setSelectedTraderId] = useState<string | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<TraderProfileResponse | null>(null);

  const assetIds = useMemo(
    () => Array.from(new Set(markets.flatMap((market) => market.clobTokenIds))).slice(0, 80),
    [markets],
  );

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/polymarket/markets?limit=8");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as MarketResponse;
      setMarkets(payload.markets ?? []);
      setMarketLastUpdate(payload.time);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setMarketStatus("OFFLINE");
    } finally {
      setMarketsLoading(false);
    }
  }, []);

  const loadTraderData = useCallback(async () => {
    setTradersLoading(true);
    setError(null);

    try {
      const query = new URLSearchParams({
        period,
        sort,
        limit: "80",
      });
      if (search.trim().length > 0) {
        query.set("search", search.trim());
      }

      const [tradersResponse, tradesResponse] = await Promise.all([
        fetch(`/api/polymarket/traders/active?${query.toString()}`),
        fetch(`/api/polymarket/trades/live?period=${period}&limit=120`),
      ]);

      if (!tradersResponse.ok || !tradesResponse.ok) {
        throw new Error(`HTTP ${tradersResponse.status}/${tradesResponse.status}`);
      }

      const tradersPayload = (await tradersResponse.json()) as ActiveTradersResponse;
      const tradesPayload = (await tradesResponse.json()) as LiveTradesResponse;

      setTraders(tradersPayload.traders ?? []);
      setLiveTrades((current) => mergeTrades(tradesPayload.trades ?? [], current).slice(0, 150));
      setTradersDataStatus(tradersPayload.dataSourceStatus);
      setTradersLastUpdate(tradersPayload.time);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setTradersStatus("OFFLINE");
      setTradersDataStatus("UNAVAILABLE");
    } finally {
      setTradersLoading(false);
    }
  }, [period, search, sort]);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  useEffect(() => {
    void loadTraderData();
    const timer = window.setInterval(() => {
      void loadTraderData();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [loadTraderData]);

  useEffect(() => {
    if (selectedTraderId === null) {
      setSelectedTrader(null);
      return;
    }

    let stopped = false;

    const load = async () => {
      try {
        const response = await fetch(`/api/polymarket/traders/${selectedTraderId}?period=${period}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as TraderProfileResponse;
        if (!stopped) {
          setSelectedTrader(payload);
        }
      } catch (caughtError) {
        if (!stopped) {
          setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
          setSelectedTrader(null);
        }
      }
    };

    void load();

    return () => {
      stopped = true;
    };
  }, [period, selectedTraderId]);

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

      setMarketStatus("CONNECTING");
      socket = new WebSocket(buildWebSocketUrl("/ws/polymarket"));

      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "subscribe", assetIds }));
      });

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (message === null) {
          return;
        }

        if (message.type === "status") {
          setMarketStatus(message.status === "LIVE" ? "LIVE" : "OFFLINE");
          setMarketLatencyMs(readNumber(message.latencyMs));
          setMarketLastUpdate(readString(message.time) ?? new Date().toISOString());
          return;
        }

        if (message.type === "price") {
          const price = normalizeLivePrice(message);
          if (price === null) {
            return;
          }

          setPrices((current) => ({ ...current, [price.assetId]: price }));
          setMarketLatencyMs(price.latencyMs);
          setMarketLastUpdate(price.time);
          setMarketStatus("LIVE");
          return;
        }

        if (message.type === "error") {
          setError(readString(message.message) ?? "Market WebSocket error");
          setMarketStatus("OFFLINE");
        }
      });

      socket.addEventListener("close", () => {
        setMarketStatus("OFFLINE");
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 3_000);
        }
      });

      socket.addEventListener("error", () => setMarketStatus("OFFLINE"));
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

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) {
        return;
      }

      setTradersStatus("CONNECTING");
      socket = new WebSocket(buildWebSocketUrl(`/ws/traders?period=${period}`));

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (message === null) {
          return;
        }

        if (message.type === "status") {
          setTradersStatus(message.status === "LIVE" ? "LIVE" : "OFFLINE");
          setTradersLatencyMs(readNumber(message.latencyMs));
          setTradersDataStatus(readDataSourceStatus(message.dataSourceStatus));
          setTradersLastUpdate(readString(message.time) ?? new Date().toISOString());
          return;
        }

        if (message.type === "trades" && Array.isArray(message.trades)) {
          const trades = message.trades.filter(isNormalizedTrade);
          setLiveTrades((current) => mergeTrades(trades, current).slice(0, 150));
          setTradersDataStatus(readDataSourceStatus(message.dataSourceStatus));
          setTradersLastUpdate(readString(message.time) ?? new Date().toISOString());
        }
      });

      socket.addEventListener("close", () => {
        setTradersStatus("OFFLINE");
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 3_000);
        }
      });

      socket.addEventListener("error", () => setTradersStatus("OFFLINE"));
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [period]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">BLACK-GOAT</p>
          <h1>Polymarket read-only terminal</h1>
        </div>
        <div className="status-stack">
          <StatusPanel label="Markets WS" status={marketStatus} latencyMs={marketLatencyMs} />
          <StatusPanel label="Traders WS" status={tradersStatus} latencyMs={tradersLatencyMs} />
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        <button className={tab === "markets" ? "active" : ""} type="button" onClick={() => setTab("markets")}>
          Markets
        </button>
        <button className={tab === "traders" ? "active" : ""} type="button" onClick={() => setTab("traders")}>
          Active Traders
        </button>
      </nav>

      {error !== null ? <p className="error">{error}</p> : null}

      {tab === "markets" ? (
        <MarketsView
          assetIds={assetIds}
          lastUpdate={marketLastUpdate}
          loading={marketsLoading}
          markets={markets}
          prices={prices}
          onRefresh={loadMarkets}
        />
      ) : (
        <TradersView
          dataSourceStatus={tradersDataStatus}
          lastUpdate={tradersLastUpdate}
          liveTrades={liveTrades}
          loading={tradersLoading}
          onRefresh={loadTraderData}
          period={period}
          search={search}
          selectedTrader={selectedTrader}
          selectedTraderId={selectedTraderId}
          setPeriod={setPeriod}
          setSearch={setSearch}
          setSelectedTraderId={setSelectedTraderId}
          setSort={setSort}
          sort={sort}
          traders={traders}
        />
      )}
    </main>
  );
}

function StatusPanel({ label, status, latencyMs }: { label: string; status: LiveStatus; latencyMs: number | null }) {
  return (
    <div className="status-panel">
      <span className={`status-dot ${status.toLowerCase()}`} />
      <span className="status-label">{label}</span>
      <strong>{status}</strong>
      <span className="latency">{formatLatency(latencyMs)}</span>
    </div>
  );
}

function MarketsView({
  assetIds,
  lastUpdate,
  loading,
  markets,
  onRefresh,
  prices,
}: {
  assetIds: string[];
  lastUpdate: string | null;
  loading: boolean;
  markets: PublicMarket[];
  onRefresh: () => Promise<void>;
  prices: Record<string, LivePrice>;
}) {
  return (
    <>
      <section className="summary" aria-label="Market status">
        <Metric label="Markets" value={loading ? "..." : String(markets.length)} />
        <Metric label="Assets" value={String(assetIds.length)} />
        <Metric label="Last update" value={formatTime(lastUpdate)} />
        <button type="button" onClick={() => void onRefresh()}>
          Refresh
        </button>
      </section>

      <section className="market-list" aria-label="Markets">
        {loading ? <p className="empty">Loading markets...</p> : null}
        {!loading && markets.length === 0 ? <p className="empty">No markets returned.</p> : null}
        {markets.map((market, index) => (
          <MarketRow key={market.id ?? market.slug ?? market.question ?? index} market={market} prices={prices} />
        ))}
      </section>
    </>
  );
}

function TradersView({
  dataSourceStatus,
  lastUpdate,
  liveTrades,
  loading,
  onRefresh,
  period,
  search,
  selectedTrader,
  selectedTraderId,
  setPeriod,
  setSearch,
  setSelectedTraderId,
  setSort,
  sort,
  traders,
}: {
  dataSourceStatus: DataSourceStatus;
  lastUpdate: string | null;
  liveTrades: NormalizedTrade[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  period: PeriodKey;
  search: string;
  selectedTrader: TraderProfileResponse | null;
  selectedTraderId: string | null;
  setPeriod: (period: PeriodKey) => void;
  setSearch: (search: string) => void;
  setSelectedTraderId: (id: string | null) => void;
  setSort: (sort: TraderSort) => void;
  sort: TraderSort;
  traders: ActiveTrader[];
}) {
  return (
    <section className="trader-grid">
      <div className="terminal-panel wide">
        <div className="panel-head">
          <div>
            <h2>Active Traders</h2>
            <p>{dataSourceStatus}</p>
          </div>
          <button type="button" onClick={() => void onRefresh()}>
            Refresh
          </button>
        </div>

        <div className="controls">
          <label>
            <span>Search</span>
            <input
              placeholder="wallet / username"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as TraderSort)}>
              <option value="volume">Volume</option>
              <option value="trades">Trades</option>
              <option value="activity">Last activity</option>
            </select>
          </label>
          <label>
            <span>Period</span>
            <select value={period} onChange={(event) => setPeriod(event.target.value as PeriodKey)}>
              {PERIODS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <Metric label="Last update" value={formatTime(lastUpdate)} />
        </div>

        <p className="notice">Scores analytiques indicatifs en lecture seule, pas un conseil financier.</p>
        <ActiveTraderTable loading={loading} onSelect={setSelectedTraderId} selectedId={selectedTraderId} traders={traders} />
      </div>

      <TraderDetail selectedTrader={selectedTrader} />
      <LiveTape liveTrades={liveTrades} />
    </section>
  );
}

function ActiveTraderTable({
  loading,
  onSelect,
  selectedId,
  traders,
}: {
  loading: boolean;
  onSelect: (id: string) => void;
  selectedId: string | null;
  traders: ActiveTrader[];
}) {
  if (loading) {
    return <p className="empty terminal-empty">Loading traders...</p>;
  }

  if (traders.length === 0) {
    return <p className="empty terminal-empty">UNAVAILABLE: no public traders returned for this filter.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Trader</th>
            <th>Volume</th>
            <th>Trades</th>
            <th>Last activity</th>
            <th>Market</th>
            <th>Outcome</th>
            <th>Price</th>
            <th>Amount</th>
            <th>Score</th>
            <th>Profile</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {traders.map((trader) => (
            <tr
              className={selectedId === trader.id ? "selected" : ""}
              key={trader.id}
              onClick={() => onSelect(trader.id)}
            >
              <td>
                <button className="link-button" type="button">
                  {trader.username ?? trader.pseudonym ?? shortWallet(trader.wallet)}
                </button>
                <span className="subtext">{shortWallet(trader.wallet)}</span>
              </td>
              <td>{formatUsd(trader.volumeRecent)}</td>
              <td>{trader.tradesRecent}</td>
              <td>{formatTime(trader.lastActivity)}</td>
              <td>{trader.market ?? "unavailable"}</td>
              <td>{trader.outcome ?? "unavailable"}</td>
              <td>{formatProbability(trader.price)}</td>
              <td>{formatUsd(trader.amount)}</td>
              <td>{formatScore(trader.scores.overallScore)}</td>
              <td>
                <a href={trader.profileUrl} target="_blank" rel="noreferrer">
                  Profile
                </a>
              </td>
              <td>{trader.dataSourceStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TraderDetail({ selectedTrader }: { selectedTrader: TraderProfileResponse | null }) {
  if (selectedTrader === null) {
    return (
      <aside className="terminal-panel">
        <div className="panel-head">
          <h2>Trader Profile</h2>
        </div>
        <p className="terminal-empty">Select a trader.</p>
      </aside>
    );
  }

  const trader = selectedTrader.trader;
  const insufficient = selectedTrader.summary.message !== null;

  return (
    <aside className="terminal-panel">
      <div className="panel-head">
        <div>
          <h2>{trader.username ?? trader.pseudonym ?? shortWallet(trader.wallet)}</h2>
          <p>{selectedTrader.dataSourceStatus}</p>
        </div>
        <a href={trader.profileUrl} target="_blank" rel="noreferrer">
          Profile
        </a>
      </div>

      {insufficient ? <p className="notice">Données insuffisantes</p> : null}

      <div className="detail-grid">
        <Metric label="Wallet" value={shortWallet(trader.wallet)} />
        <Metric label="Volume" value={formatUsd(selectedTrader.summary.volumeRecent)} />
        <Metric label="Trades" value={String(selectedTrader.summary.tradesRecent)} />
        <Metric label="Last activity" value={formatTime(selectedTrader.summary.lastActivity)} />
        <Metric label="Activity score" value={formatScore(selectedTrader.summary.scores.activityScore)} />
        <Metric label="Volume score" value={formatScore(selectedTrader.summary.scores.volumeScore)} />
        <Metric label="Consistency" value={formatScore(selectedTrader.summary.scores.consistencyScore)} />
        <Metric label="Risk" value="placeholder" />
        <Metric label="Overall" value={formatScore(selectedTrader.summary.scores.overallScore)} />
      </div>

      <h3>Most traded markets</h3>
      <div className="mini-list">
        {selectedTrader.marketsMostTraded.length === 0 ? <p>unavailable</p> : null}
        {selectedTrader.marketsMostTraded.map((market) => (
          <a key={market.conditionId ?? market.marketTitle ?? market.marketSlug ?? "market"} href={market.marketUrl ?? "#"} target="_blank" rel="noreferrer">
            <span>{market.marketTitle ?? "unavailable"}</span>
            <strong>{formatUsd(market.volume)}</strong>
          </a>
        ))}
      </div>

      <h3>Latest trades</h3>
      <div className="mini-list">
        {selectedTrader.latestTrades.slice(0, 8).map((trade) => (
          <span key={trade.id}>
            {formatTime(trade.time)} · {trade.side ?? "unavailable"} · {trade.outcome ?? "unavailable"} ·{" "}
            {formatUsd(trade.amount)}
          </span>
        ))}
      </div>
    </aside>
  );
}

function LiveTape({ liveTrades }: { liveTrades: NormalizedTrade[] }) {
  return (
    <section className="terminal-panel tape-panel">
      <div className="panel-head">
        <div>
          <h2>Live Trading Tape</h2>
          <p>Polling public Data API via backend WebSocket</p>
        </div>
      </div>

      {liveTrades.length === 0 ? <p className="terminal-empty">UNAVAILABLE: no live trades returned.</p> : null}
      <div className="tape-list">
        {liveTrades.slice(0, 80).map((trade) => (
          <div className="tape-row" key={trade.id}>
            <span>{formatTime(trade.time)}</span>
            {trade.profileUrl === null ? (
              <span>{trade.trader ?? "unavailable"}</span>
            ) : (
              <a href={trade.profileUrl} target="_blank" rel="noreferrer">
                {trade.trader ?? shortWallet(trade.wallet)}
              </a>
            )}
            <strong className={trade.side === "SELL" ? "sell" : "buy"}>{trade.side ?? "unavailable"}</strong>
            {trade.marketUrl === null ? (
              <span>{trade.marketTitle ?? "unavailable"}</span>
            ) : (
              <a href={trade.marketUrl} target="_blank" rel="noreferrer">
                {trade.marketTitle ?? "market"}
              </a>
            )}
            <span>{trade.outcome ?? "unavailable"}</span>
            <span>{formatProbability(trade.price)}</span>
            <span>{formatUsd(trade.amount)}</span>
          </div>
        ))}
      </div>
    </section>
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
          const displayPrice =
            livePrice?.price ?? calculateMidpoint(livePrice?.bestBid ?? null, livePrice?.bestAsk ?? null) ?? initialPrice;

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function buildWebSocketUrl(pathname: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${pathname}`;
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

function mergeTrades(incoming: NormalizedTrade[], current: NormalizedTrade[]) {
  const map = new Map<string, NormalizedTrade>();
  for (const trade of [...incoming, ...current]) {
    map.set(trade.id, trade);
  }

  return Array.from(map.values()).sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
}

function calculateMidpoint(bestBid: number | null, bestAsk: number | null) {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function formatProbability(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  const digits = value > 0 && value < 0.01 ? 2 : 1;
  return `${(value * 100).toFixed(digits)}%`;
}

function formatLatency(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "latency unavailable";
  }

  return `${Math.round(value)} ms`;
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatTime(value: string | null) {
  if (value === null) {
    return "unavailable";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatScore(value: number | null) {
  return value === null ? "unavailable" : `${value}/100`;
}

function shortWallet(value: string | null) {
  if (value === null) {
    return "unavailable";
  }

  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
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

function readDataSourceStatus(value: unknown): DataSourceStatus {
  return value === "REAL POLYMARKET DATA" ? "REAL POLYMARKET DATA" : "UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedTrade(value: unknown): value is NormalizedTrade {
  return isRecord(value) && typeof value.id === "string";
}
