import { useCallback, useEffect, useMemo, useState } from "react";

type DataSourceStatus = "REAL POLYMARKET DATA" | "UNAVAILABLE";
type LiveStatus = "CONNECTING" | "LIVE" | "OFFLINE";
type PeriodKey = "5m" | "15m" | "1h" | "4h" | "24h";
type Tab = "markets" | "traders";
type TraderSort = "volume" | "trades" | "activity" | "score";

type MarketResponse = {
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
  acceptingOrders: boolean | null;
};

type LivePrice = {
  assetId: string;
  eventType: string;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
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
  profileUrl: string;
  dataSourceStatus: DataSourceStatus;
  scores: TraderScores;
};

type NormalizedTrade = {
  id: string;
  wallet: string | null;
  trader: string | null;
  side: string | null;
  marketTitle: string | null;
  outcome: string | null;
  size: number | null;
  price: number | null;
  amount: number | null;
  timestamp: number | null;
  time: string | null;
  profileUrl: string | null;
  marketUrl: string | null;
  dataSourceStatus: DataSourceStatus;
};

type ActiveTradersResponse = {
  dataSourceStatus: DataSourceStatus;
  traders: ActiveTrader[];
  time: string;
};

type LiveTradesResponse = {
  dataSourceStatus: DataSourceStatus;
  trades: NormalizedTrade[];
  time: string;
};

type TraderProfileResponse = {
  dataSourceStatus: DataSourceStatus;
  profileDataSourceStatus: DataSourceStatus;
  trader: {
    wallet: string;
    username: string | null;
    pseudonym: string | null;
    bio: string | null;
    profileUrl: string;
  };
  summary: {
    message: string | null;
    volumeRecent: number | null;
    tradesRecent: number;
    lastActivity: string | null;
    scores: TraderScores;
  };
  latestTrades: NormalizedTrade[];
  marketsMostTraded: Array<{
    conditionId: string | null;
    marketTitle: string | null;
    marketUrl: string | null;
    trades: number;
    volume: number;
    lastActivity: string | null;
  }>;
  outcomesTraded?: Array<{
    outcome: string | null;
    trades: number;
    volume: number;
    lastActivity: string | null;
  }>;
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
  time?: unknown;
  trades?: unknown;
  dataSourceStatus?: unknown;
};

const PERIODS: PeriodKey[] = ["5m", "15m", "1h", "4h", "24h"];

export default function App() {
  const [tab, setTab] = useState<Tab>("markets");
  const [error, setError] = useState<string | null>(null);

  const [markets, setMarkets] = useState<PublicMarket[]>([]);
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [marketStatus, setMarketStatus] = useState<LiveStatus>("CONNECTING");
  const [marketLatencyMs, setMarketLatencyMs] = useState<number | null>(null);
  const [marketLastUpdate, setMarketLastUpdate] = useState<string | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(true);

  const [period, setPeriod] = useState<PeriodKey>("15m");
  const [sort, setSort] = useState<TraderSort>("volume");
  const [search, setSearch] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [minTrades, setMinTrades] = useState("");
  const [traders, setTraders] = useState<ActiveTrader[]>([]);
  const [liveTrades, setLiveTrades] = useState<NormalizedTrade[]>([]);
  const [tapePaused, setTapePaused] = useState(false);
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
        limit: "80",
        period,
        sort,
      });

      if (search.trim().length > 0) {
        query.set("search", search.trim());
      }
      if (minVolume.trim().length > 0) {
        query.set("minVolume", minVolume.trim());
      }
      if (minTrades.trim().length > 0) {
        query.set("minTrades", minTrades.trim());
      }

      const tradersResponse = await fetch(`/api/polymarket/traders/active?${query.toString()}`);
      if (!tradersResponse.ok) {
        throw new Error(`HTTP ${tradersResponse.status}`);
      }

      const tradersPayload = (await tradersResponse.json()) as ActiveTradersResponse;
      setTraders(tradersPayload.traders ?? []);
      setTradersDataStatus(tradersPayload.dataSourceStatus);
      setTradersLastUpdate(tradersPayload.time);

      if (!tapePaused) {
        const tradesResponse = await fetch(`/api/polymarket/trades/live?period=${period}&limit=50`);
        if (!tradesResponse.ok) {
          throw new Error(`HTTP ${tradesResponse.status}`);
        }

        const tradesPayload = (await tradesResponse.json()) as LiveTradesResponse;
        setLiveTrades((current) => mergeTrades(tradesPayload.trades ?? [], current).slice(0, 50));
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setTradersStatus("OFFLINE");
      setTradersDataStatus("UNAVAILABLE");
    } finally {
      setTradersLoading(false);
    }
  }, [minTrades, minVolume, period, search, sort, tapePaused]);

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
        socket?.send(JSON.stringify({ assetIds, type: "subscribe" }));
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

        if (!tapePaused && message.type === "trades" && Array.isArray(message.trades)) {
          const trades = message.trades.filter(isNormalizedTrade);
          setLiveTrades((current) => mergeTrades(trades, current).slice(0, 50));
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
  }, [period, tapePaused]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">BLACK-GOAT</p>
          <h1>Polymarket read-only terminal</h1>
        </div>
        <div className="status-stack">
          <StatusPanel label="Markets WS" latencyMs={marketLatencyMs} status={marketStatus} />
          <StatusPanel label="Traders WS" latencyMs={tradersLatencyMs} status={tradersStatus} />
        </div>
      </header>

      <nav aria-label="Views" className="tabs">
        <button className={tab === "markets" ? "active" : ""} onClick={() => setTab("markets")} type="button">
          Markets
        </button>
        <button className={tab === "traders" ? "active" : ""} onClick={() => setTab("traders")} type="button">
          Active Traders
        </button>
      </nav>

      {error !== null ? <p className="error">API unavailable or returned an error: {error}</p> : null}

      {tab === "markets" ? (
        <MarketsView
          assetIds={assetIds}
          lastUpdate={marketLastUpdate}
          loading={marketsLoading}
          markets={markets}
          onRefresh={loadMarkets}
          prices={prices}
        />
      ) : (
        <TradersView
          dataSourceStatus={tradersDataStatus}
          lastUpdate={tradersLastUpdate}
          liveTrades={liveTrades}
          loading={tradersLoading}
          minTrades={minTrades}
          minVolume={minVolume}
          onRefresh={loadTraderData}
          period={period}
          search={search}
          selectedTrader={selectedTrader}
          selectedTraderId={selectedTraderId}
          setMinTrades={setMinTrades}
          setMinVolume={setMinVolume}
          setPeriod={setPeriod}
          setSearch={setSearch}
          setSelectedTraderId={setSelectedTraderId}
          setSort={setSort}
          setTapePaused={setTapePaused}
          sort={sort}
          tapePaused={tapePaused}
          traders={traders}
        />
      )}
    </main>
  );
}

function StatusPanel({ label, latencyMs, status }: { label: string; latencyMs: number | null; status: LiveStatus }) {
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
      <section aria-label="Market status" className="summary">
        <Metric label="Markets" value={loading ? "..." : String(markets.length)} />
        <Metric label="Assets" value={String(assetIds.length)} />
        <Metric label="Last update" value={formatTime(lastUpdate)} />
        <button onClick={() => void onRefresh()} type="button">
          Refresh
        </button>
      </section>

      <section aria-label="Markets" className="market-list">
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
  minTrades,
  minVolume,
  onRefresh,
  period,
  search,
  selectedTrader,
  selectedTraderId,
  setMinTrades,
  setMinVolume,
  setPeriod,
  setSearch,
  setSelectedTraderId,
  setSort,
  setTapePaused,
  sort,
  tapePaused,
  traders,
}: {
  dataSourceStatus: DataSourceStatus;
  lastUpdate: string | null;
  liveTrades: NormalizedTrade[];
  loading: boolean;
  minTrades: string;
  minVolume: string;
  onRefresh: () => Promise<void>;
  period: PeriodKey;
  search: string;
  selectedTrader: TraderProfileResponse | null;
  selectedTraderId: string | null;
  setMinTrades: (value: string) => void;
  setMinVolume: (value: string) => void;
  setPeriod: (period: PeriodKey) => void;
  setSearch: (search: string) => void;
  setSelectedTraderId: (id: string | null) => void;
  setSort: (sort: TraderSort) => void;
  setTapePaused: (paused: boolean) => void;
  sort: TraderSort;
  tapePaused: boolean;
  traders: ActiveTrader[];
}) {
  return (
    <section className="trader-grid">
      <div className="terminal-panel wide">
        <div className="panel-head">
          <div>
            <h2>Active Traders</h2>
            <p>Only public Polymarket trades are aggregated. Missing fields stay unavailable.</p>
          </div>
          <SourceBadge status={dataSourceStatus} />
          <button onClick={() => void onRefresh()} type="button">
            Refresh
          </button>
        </div>

        <div className="controls">
          <label>
            <span>Search</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="wallet / username"
              title="Filters by wallet, username, or pseudonym returned by Polymarket."
              type="search"
              value={search}
            />
          </label>
          <label>
            <span>Sort</span>
            <select
              onChange={(event) => setSort(event.target.value as TraderSort)}
              title="Sort active traders by one public aggregation field."
              value={sort}
            >
              <option value="volume">Volume</option>
              <option value="activity">Recent activity</option>
              <option value="trades">Trades</option>
              <option value="score">Indicative score</option>
            </select>
          </label>
          <label>
            <span>Period</span>
            <select
              onChange={(event) => setPeriod(event.target.value as PeriodKey)}
              title="Local time window applied to public trades returned by Polymarket."
              value={period}
            >
              {PERIODS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Min volume</span>
            <input
              min="0"
              onChange={(event) => setMinVolume(event.target.value)}
              placeholder="0"
              title="Minimum derived notional volume: size x price, only when both values are returned."
              type="number"
              value={minVolume}
            />
          </label>
          <label>
            <span>Min trades</span>
            <input
              min="0"
              onChange={(event) => setMinTrades(event.target.value)}
              placeholder="0"
              title="Minimum number of public trades observed in the selected period."
              type="number"
              value={minTrades}
            />
          </label>
          <Metric label="Last update" value={formatTime(lastUpdate)} />
        </div>

        <p className="notice">
          Indicative score is an analytical read-only score. It is not financial advice and never creates orders.
        </p>
        <ActiveTraderTable loading={loading} onSelect={setSelectedTraderId} selectedId={selectedTraderId} traders={traders} />
      </div>

      <TraderDetail selectedTrader={selectedTrader} />
      <LiveTape liveTrades={liveTrades} paused={tapePaused} setPaused={setTapePaused} />
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
            <th title="Wallet, username, or pseudonym returned by Polymarket.">Trader</th>
            <th title="Recent notional volume derived from public trade size x price.">Volume</th>
            <th title="Number of public trades seen in the selected period.">Trades</th>
            <th title="Most recent public trade timestamp.">Last activity</th>
            <th title="Market title from the latest public trade.">Market</th>
            <th title="Outcome label from the latest public trade.">Outcome</th>
            <th title="Latest public trade price.">Price</th>
            <th title="Read-only analytical score, not financial advice.">Indicative score</th>
            <th title="Whether this row uses real public Polymarket data or unavailable fields.">Source</th>
          </tr>
        </thead>
        <tbody>
          {traders.map((trader) => (
            <tr className={selectedId === trader.id ? "selected" : ""} key={trader.id} onClick={() => onSelect(trader.id)}>
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
              <td>{formatScore(trader.scores.overallScore)}</td>
              <td>
                <SourceBadge status={trader.dataSourceStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TraderDetail({ selectedTrader }: { selectedTrader: TraderProfileResponse | null }) {
  const [copied, setCopied] = useState(false);

  if (selectedTrader === null) {
    return (
      <aside className="terminal-panel">
        <div className="panel-head">
          <h2>Trader Profile</h2>
        </div>
        <p className="terminal-empty">Select a trader to inspect the public profile context.</p>
      </aside>
    );
  }

  const trader = selectedTrader.trader;
  const insufficient = selectedTrader.summary.message !== null;
  const outcomesTraded = selectedTrader.outcomesTraded ?? [];

  const copyWallet = async () => {
    await copyToClipboard(trader.wallet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  return (
    <aside className="terminal-panel">
      <div className="panel-head">
        <div>
          <h2>{trader.username ?? trader.pseudonym ?? shortWallet(trader.wallet)}</h2>
          <p>Official public profile and recent public trades.</p>
        </div>
        <SourceBadge status={selectedTrader.dataSourceStatus} />
        <a href={trader.profileUrl} rel="noreferrer" target="_blank">
          Polymarket
        </a>
      </div>

      {insufficient ? <p className="notice">Donnees insuffisantes: Polymarket did not return enough public data.</p> : null}

      <div className="wallet-box">
        <span>{trader.wallet}</span>
        <button onClick={() => void copyWallet()} type="button">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="detail-grid">
        <Metric label="Volume" value={formatUsd(selectedTrader.summary.volumeRecent)} />
        <Metric label="Trades" value={String(selectedTrader.summary.tradesRecent)} />
        <Metric label="Last activity" value={formatTime(selectedTrader.summary.lastActivity)} />
        <Metric label="Data source" value={selectedTrader.dataSourceStatus} />
      </div>

      <section className="score-box">
        <div className="panel-head compact">
          <h3>Indicative score</h3>
          <strong>{formatScore(selectedTrader.summary.scores.overallScore)}</strong>
        </div>
        <p>Score analytique indicatif en lecture seule, pas un conseil financier.</p>
        <div className="score-grid">
          <Metric label="Activity" value={formatScore(selectedTrader.summary.scores.activityScore)} />
          <Metric label="Volume" value={formatScore(selectedTrader.summary.scores.volumeScore)} />
          <Metric label="Consistency" value={formatScore(selectedTrader.summary.scores.consistencyScore)} />
          <Metric label="Risk" value="unavailable" />
        </div>
      </section>

      <h3>Top recent markets</h3>
      <div className="mini-list">
        {selectedTrader.marketsMostTraded.length === 0 ? <p>unavailable</p> : null}
        {selectedTrader.marketsMostTraded.map((market) => (
          <a
            href={market.marketUrl ?? "#"}
            key={market.conditionId ?? market.marketTitle ?? "market"}
            rel="noreferrer"
            target="_blank"
          >
            <span>{market.marketTitle ?? "unavailable"}</span>
            <strong>{formatUsd(market.volume)}</strong>
          </a>
        ))}
      </div>

      <h3>Outcomes traded</h3>
      <div className="mini-list">
        {outcomesTraded.length === 0 ? <p>unavailable</p> : null}
        {outcomesTraded.map((item) => (
          <span key={item.outcome ?? "unavailable"}>
            {item.outcome ?? "unavailable"}
            <strong>{item.trades} trades</strong>
          </span>
        ))}
      </div>

      <h3>Latest trades</h3>
      <div className="mini-list">
        {selectedTrader.latestTrades.length === 0 ? <p>unavailable</p> : null}
        {selectedTrader.latestTrades.slice(0, 8).map((trade) => (
          <span key={trade.id}>
            {formatTime(trade.time)} | {trade.side ?? "unavailable"} | {trade.outcome ?? "unavailable"} |{" "}
            {formatUsd(trade.amount)}
          </span>
        ))}
      </div>
    </aside>
  );
}

function LiveTape({
  liveTrades,
  paused,
  setPaused,
}: {
  liveTrades: NormalizedTrade[];
  paused: boolean;
  setPaused: (paused: boolean) => void;
}) {
  return (
    <section className="terminal-panel tape-panel">
      <div className="panel-head">
        <div>
          <h2>Live Trading Tape</h2>
          <p>Last 50 public trade events, streamed by backend polling.</p>
        </div>
        <button onClick={() => setPaused(!paused)} type="button">
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {paused ? <p className="notice">Tape paused locally. No trade events are added while paused.</p> : null}
      {liveTrades.length === 0 ? <p className="terminal-empty">UNAVAILABLE: no public live trades returned.</p> : null}
      <div className="tape-list">
        <div className="tape-row tape-header">
          <span>Time</span>
          <span>Trader</span>
          <span>Action</span>
          <span>Market</span>
          <span>Outcome</span>
          <span>Price</span>
          <span>Size / Amount</span>
          <span>Source</span>
        </div>
        {liveTrades.slice(0, 50).map((trade) => (
          <div className="tape-row" key={trade.id}>
            <span>{formatTime(trade.time)}</span>
            {trade.profileUrl === null ? (
              <span>{trade.trader ?? "unavailable"}</span>
            ) : (
              <a href={trade.profileUrl} rel="noreferrer" target="_blank">
                {trade.trader ?? shortWallet(trade.wallet)}
              </a>
            )}
            <strong className={trade.side === "SELL" ? "sell" : "buy"}>{trade.side ?? "unavailable"}</strong>
            {trade.marketUrl === null ? (
              <span>{trade.marketTitle ?? "unavailable"}</span>
            ) : (
              <a href={trade.marketUrl} rel="noreferrer" target="_blank">
                {trade.marketTitle ?? "market"}
              </a>
            )}
            <span>{trade.outcome ?? "unavailable"}</span>
            <span>{formatProbability(trade.price)}</span>
            <span>{formatTradeSizeAmount(trade)}</span>
            <SourceBadge status={trade.dataSourceStatus} />
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
          <a href={`https://polymarket.com/event/${market.slug}`} rel="noreferrer" target="_blank">
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

function SourceBadge({ status }: { status: DataSourceStatus }) {
  return <span className={`source-badge ${status === "REAL POLYMARKET DATA" ? "real" : "unavailable"}`}>{status}</span>;
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
    bestAsk: readNumber(message.bestAsk),
    bestBid: readNumber(message.bestBid),
    eventType: readString(message.eventType) ?? "price",
    latencyMs: readNumber(message.latencyMs),
    price: readNumber(message.price),
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

function formatScore(value: number | null) {
  return value === null ? "unavailable" : `${value}/100`;
}

function formatTradeSizeAmount(trade: NormalizedTrade) {
  const size = trade.size === null ? "size unavailable" : `${trade.size.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  const amount = formatUsd(trade.amount);
  return `${size} / ${amount}`;
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    style: "currency",
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

function shortWallet(value: string | null) {
  if (value === null) {
    return "unavailable";
  }

  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard === undefined) {
    return;
  }

  await navigator.clipboard.writeText(value);
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
