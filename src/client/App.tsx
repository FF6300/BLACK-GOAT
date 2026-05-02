import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { evaluateDeRisk } from "../engines/deRiskEngine";
import { evaluateEntryOpportunity } from "../engines/entryOpportunityEngine";
import { evaluateFinalSettlementForecast } from "../engines/finalSettlementForecastEngine";
import { createForcedPaperPick, decideMandatoryMarket } from "../engines/mandatoryMarketDecisionEngine";
import { decideOpeningEntry } from "../engines/openingEntryEngine";
import { createOpeningScenarios } from "../engines/openingScenarioEngine";
import { evaluateSmartScaling } from "../engines/smartScalingEngine";
import { BLACK_GOAT_V3_CONFIG, DEFAULT_OPENING_SCENARIO_SETTINGS } from "../engines/v3Config";
import type {
  Candle,
  Crypto5mMarket,
  DeRiskDecision,
  EntryOpportunityResult,
  FinalSettlementForecast,
  FinalSettlementInput,
  ForcedPaperPick,
  MandatoryDecisionResult,
  MarketRegime,
  MarketDecisionStatus,
  OpeningEntryDecision,
  OpeningEntryMode,
  OpeningScenarioResult,
  OpeningScenarioSettings,
  PaperPosition,
  SmartScalingDecision,
} from "../engines/types";
import { cubicBezier, getChangeDirection, motionSeconds, motionTokens, type ChangeDirection } from "../ui/motion";

type DataSourceStatus = "REAL POLYMARKET DATA" | "UNAVAILABLE";
type LiveStatus = "CONNECTING" | "LIVE" | "STALE" | "OFFLINE";
type PeriodKey = "5m" | "15m" | "1h" | "4h" | "24h";
type Tab = "markets" | "traders";
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
type TopTraderPeriod = "10m" | "30m" | "1h" | "4h" | "day" | "week" | "all";
type TopTraderSort = "globalScore" | "pnl" | "volume" | "activity";

type MarketResponse = {
  markets: PublicMarket[];
  time: string;
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
  acceptingOrders: boolean | null;
  endDate: string | null;
  eventStartTime: string | null;
  lastTradePrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  oneHourPriceChange: number | null;
  priceToBeat: number | null;
  finalPrice: number | null;
  sourceType: "CURATED_LIVE_CRYPTO" | "GAMMA_VOLUME";
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

type CryptoPriceUpdate = {
  type: "crypto_price";
  source: "chainlink" | "binance";
  symbol: string;
  price: number;
  upstreamTimestamp: number | null;
  latencyMs: number | null;
  time: string;
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
  averagePlacement: number | null;
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
    averagePlacement: number | null;
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
  market?: unknown;
  conditionId?: unknown;
  price?: unknown;
  bestBid?: unknown;
  bestAsk?: unknown;
  time?: unknown;
  source?: unknown;
  symbol?: unknown;
  upstreamTimestamp?: unknown;
  trades?: unknown;
  traders?: unknown;
  dataSourceStatus?: unknown;
  lastWsEventAt?: unknown;
  lastTradeEventAt?: unknown;
  newestTradeAt?: unknown;
  secondsSinceLastTradeEvent?: unknown;
  wsEventsPerMinute?: unknown;
  tradesReceivedPerMinute?: unknown;
};

type TradersWsMeta = {
  lastWsEventAt: string | null;
  lastTradeEventAt: string | null;
  newestTradeAt: string | null;
  secondsSinceLastTradeEvent: number | null;
  wsEventsPerMinute: number | null;
  tradesReceivedPerMinute: number | null;
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

type TopTradersResponse = {
  dataSourceStatus: DataSourceStatus;
  period: TopTraderPeriod;
  sort: TopTraderSort;
  traders: TopTrader[];
  time: string;
};

type PriceHistoryResponse = {
  history: Record<string, Array<{ t: number; p: number }>>;
  time: string;
};

type CryptoPriceHistoryResponse = {
  count: number;
  points: Array<{ price: number; timestamp: number }>;
  symbol: string;
  time: string;
};

type ChartRangeKey = "1h" | "6h" | "1d" | "1w" | "all";

type ChartPoint = {
  t: number;
  time: string;
  [assetId: string]: number | string;
};

type CryptoChartPoint = {
  timestamp: number;
  time: string;
  price: number;
};

type BinaryMarketProbabilities = {
  upProbability: number | null;
  downProbability: number | null;
  source: string;
};

type CryptoMarketState = "BEFORE_START" | "LIVE" | "RESOLVING" | "RESOLVED";
type RouteKey = "markets" | "simulation-bot" | "opening-scenario-bot" | "top-traders" | "settings";
type BotAsset = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE" | "HYPE" | "BNB";
type BotRiskProfile = "prudent" | "normal" | "risquee" | "opportuniste" | "scalping" | "opening_scenario_bot";
type BotStatus = "running" | "paused" | "stopped";

type BotConfig = {
  id: string;
  name: string;
  startingBalance: number;
  currentBalance: number;
  riskPercentPerTrade: number;
  maxDailyRiskPercent: number;
  maxTradesPerDay: number;
  maxOpenPositions: number;
  profile: BotRiskProfile;
  allowedAssets: BotAsset[];
  minEdgePercent: number;
  maxSpreadPercent: number;
  minLiquidityScore: number;
  minTimeToExpirySeconds: number;
  maxTimeToExpirySeconds: number;
  modelMode: "rules" | "probabilistic" | "hybrid";
  fillModel: "optimistic" | "realistic" | "conservative";
  advancedRules?: BotAdvancedRules;
  status: BotStatus;
  createdAt: number;
};

type BotAssetRule = {
  enabled: boolean;
  minEdgePercent: number;
  maxSpreadPercent: number;
  riskMultiplier: number;
  reason?: string;
};

type BotDecisionType =
  | "BUY_YES"
  | "BUY_NO"
  | "NO_TRADE"
  | "WAITING_FOR_TRIGGER"
  | "WAITING_FOR_BETTER_PRICE"
  | "NO_TRADE_PRICE_TOO_EXPENSIVE"
  | "WAITING_FOR_CLARITY"
  | "NO_TRADE_RISK_BLOCKED"
  | "NO_TRADE_LOW_LIQUIDITY"
  | "NO_TRADE_WIDE_SPREAD"
  | "WAIT_FOR_CONFIRMATION"
  | "FORCED_PAPER_PICK_ONLY";
type TargetState = "ABOVE_TARGET_STRONG" | "ABOVE_TARGET_WEAK" | "NEAR_TARGET" | "BELOW_TARGET_WEAK" | "BELOW_TARGET_STRONG";
type TradeableSide = "YES" | "NO" | "NONE";

type TargetComparatorResult = {
  asset: BotAsset;
  marketId: string;
  targetPrice: number | null;
  startTime: string | null;
  expiryTime: string | null;
  currentPrice: number | null;
  timeToExpirySeconds: number;
  yesAsk: number;
  noAsk: number;
  spread: number;
  liquidity: number | null;
  distanceToTargetUsd: number | null;
  distanceToTargetPercent: number | null;
  distanceToTargetBps: number | null;
  targetState: TargetState;
  cushionScore: number;
  reversalRisk: number;
  requiredMoveToFlipTarget: number | null;
  volatilityAdjustedDistance: number;
  atrCushionRatio: number;
  tradeableSide: TradeableSide;
  decision: BotDecisionType;
  minimumCushionBpsForTrade: number;
  minimumAtrCushionRatio: number;
  bullishConfirmed: boolean;
  bearishConfirmed: boolean;
  triggerValidated: boolean;
  reasons: string[];
};

type BotAdvancedRules = {
  profile: "normal_v2";
  risk: {
    minOrderSizeUsd: number;
    effectiveRiskWarning: boolean;
    maxPositionSizeUsd: number;
    maxDailyLossUsd: number;
    maxSessionLossUsd: number;
    maxDrawdownBeforePausePercent: number;
    maxDrawdownBeforeStopPercent: number;
    maxConsecutiveLossesBeforePause: number;
    pauseAfterConsecutiveLossesMinutes: number;
  };
  positionLimits: {
    maxOpenPositions: number;
    maxCorrelatedPositions: number;
    maxOpenPositionsSameDirection: number;
    maxEntriesPerMarket: number;
    maxEntriesPerAssetPerMarket: number;
    allowPyramiding: boolean;
  };
  timing: {
    avoidFirstSeconds: number;
    avoidLastSeconds: number;
    cooldownAfterTradeSeconds: number;
    cooldownAfterLossSeconds: number;
    cooldownAfterMarketLossSameAssetSeconds: number;
  };
  edge: {
    minEdgePercent: number;
    minEdgePercentForYES: number;
    minEdgePercentForNO: number;
    uncertaintyPenaltyPercent: number;
    staleDataPenaltyPercent: number;
    lowLiquidityPenaltyPercent: number;
    contradictionPenaltyPercent: number;
    minEdgeReliability: number;
  };
  signalQuality: {
    minSignalScoreToTrade: number;
    neutralSignalForcesNoTrade: boolean;
    minDirectionalConfidenceToTrade: number;
    minModelConfidenceToTrade: number;
    blockContradictorySignals: boolean;
    maxContradictionScore: number;
    minAgreementCount: number;
  };
  marketQuality: {
    maxSpreadPercent: number;
    maxSpreadPercentHighConfidence: number;
    maxSpreadPercentLowConfidence: number;
    minLiquidityScore: number;
    minUsdAvailableAtBestAsk: number;
    minUsdAvailableWithinTwoTicks: number;
    minFillProbability: number;
    maxAllowedSlippagePercent: number;
  };
  targetDistance: {
    minDistanceFromTargetBps: number;
    maxDistanceFromTargetBps: number;
    useVolatilityAdjustedDistance: boolean;
    minVolatilityAdjustedDistance: number;
    maxRequiredMoveToWinPercent: number;
  };
  marketRegime: {
    enabled: boolean;
    blockDuringExtremeVolatility: boolean;
    reduceRiskDuringHighVolatility: boolean;
    blockDuringMajorNews: boolean;
    riskMultiplierTrend: number;
    riskMultiplierRange: number;
    riskMultiplierHighVolatility: number;
    riskMultiplierNewsEvent: number;
  };
  dataFreshness: {
    maxCryptoPriceAgeMs: number;
    maxPolymarketBookAgeMs: number;
    maxOrderflowAgeMs: number;
    maxMarketMetadataAgeMs: number;
    blockIfAnyCriticalDataStale: boolean;
  };
  systemHealth: {
    maxLatencyMs: number;
    maxApiErrorRatePercent: number;
    maxWebsocketReconnectsPerHour: number;
    blockTradingIfWebsocketDisconnected: boolean;
    blockTradingIfClockDriftMsAbove: number;
    requireNtpSync: boolean;
  };
  assetRules: Record<BotAsset, BotAssetRule>;
};

type BotDecisionDiagnostics = {
  timeToExpirySeconds: number;
  marketPhase: string;
  cryptoPrice: number | null;
  targetPrice: number | null;
  distanceToTargetPercent: number | null;
  distanceToTargetBps: number | null;
  volatility1m: number;
  volatility5m: number;
  volumeSpikeScore: number;
  cvdScore: number;
  orderbookImbalanceCrypto: number;
  orderbookImbalancePolymarket: number;
  spreadPercent: number;
  liquidityScore: number;
  slippageEstimatePercent: number;
  modelVersion: string;
  strategyMode: string;
  signalScore: number;
  contradictionScore: number;
  agreementCount: number;
  regime: string;
  dataAgeMs: number | null;
  latencyMs: number | null;
  effectiveRiskPercentPerTrade: number;
  minRequiredEdgePercent: number;
  side: "YES" | "NO";
  marketState: CryptoMarketState;
  noBid?: number | null;
  targetComparator?: TargetComparatorResult;
  deRisk?: DeRiskDecision;
  entryOpportunity?: EntryOpportunityResult;
  finalSettlement?: FinalSettlementForecast;
  forcedPaperPick?: ForcedPaperPick;
  mandatoryDecision?: MandatoryDecisionResult;
  openingEntry?: OpeningEntryDecision;
  openingNearTargetOverrideUsed?: boolean;
  openingScenario?: OpeningScenarioResult;
  openingSettings?: OpeningScenarioSettings;
  preOpenBiasDirection?: FinalSettlementForecast["preOpenBiasDirection"];
  preOpenBiasScore?: number;
  legacySignalScoreIgnored?: boolean;
  primaryScenarioKeptDespiteNoTrade?: boolean;
  forcedMinStakePaperUsed?: boolean;
  lateForcedEntryUsed?: boolean;
  smartScaling?: SmartScalingDecision;
  yesBid?: number | null;
};

type BotDecision = {
  id: string;
  botId: string;
  sessionId?: string;
  timestamp: number;
  marketId: string;
  asset: BotAsset;
  decision: BotDecisionType;
  modelProbabilityYes: number;
  modelProbabilityNo: number;
  polymarketAskYes: number;
  polymarketAskNo: number;
  edgeYes: number;
  edgeNo: number;
  edgeNet: number;
  confidence: number;
  blockedBy: string[];
  reasons: string[];
  positionSize: number;
  diagnostics?: BotDecisionDiagnostics;
};

type SimulatedPosition = {
  addCount?: number;
  id: string;
  botId: string;
  sessionId?: string;
  orderId?: string;
  fillId?: string;
  marketId: string;
  asset: BotAsset;
  side: "YES" | "NO";
  status: "open" | "closed" | "resolved";
  entryTimestamp: number;
  entryCryptoPrice: number;
  entryTokenPrice: number;
  entrySizeUsd: number;
  modelProbabilityAtEntry: number;
  edgeAtEntry: number;
  exitTimestamp?: number;
  exitCryptoPrice?: number;
  exitTokenPrice?: number;
  finalOutcome?: "YES" | "NO";
  pnlUsd?: number;
  pnlPercent?: number;
  decisionReasons: string[];
};

type SimulationSession = {
  id: string;
  botId: string;
  botName: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "paused" | "completed";
  marketIds: string[];
  assets: BotAsset[];
  startingBalance: number;
  endingBalance?: number;
  notes: string[];
};

type PaperOrder = {
  id: string;
  botId: string;
  sessionId: string;
  decisionId: string;
  marketId: string;
  asset: BotAsset;
  side: "YES" | "NO";
  type: "paper_order";
  status: "filled" | "rejected" | "cancelled";
  requestedSizeUsd: number;
  limitPrice: number;
  createdAt: number;
  reasons: string[];
};

type PaperFill = {
  id: string;
  botId: string;
  sessionId: string;
  orderId: string;
  positionId: string;
  marketId: string;
  asset: BotAsset;
  side: "YES" | "NO";
  type: "paper_fill";
  fillModel: BotConfig["fillModel"];
  filledSizeUsd: number;
  fillTokenPrice: number;
  simulatedSlippagePercent: number;
  filledAt: number;
  notes: string[];
};

type BotPerformanceStats = {
  botId: string;
  startingBalance: number;
  currentBalance: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  winRate: number;
  tradesCount: number;
  openPositionsCount: number;
  averageWinUsd: number;
  averageLossUsd: number;
  profitFactor: number;
  averageEdgePercent: number;
  fillRate: number;
  noTradeCount: number;
  blockedTradeCount: number;
  consecutiveLosses: number;
};

type DailyAnalysis = {
  asset: BotAsset;
  dailyBias: "bullish" | "bearish" | "neutral";
  confidence: number;
  volatilityRegime: "low" | "normal" | "high";
  allowedDirection: Array<"YES" | "NO">;
  riskMultiplier: number;
  avoidConditions: string[];
};

type MultiTimeframeAnalysis = {
  alignmentScore: number;
  trendDaily: string;
  trend4h: string;
  trend1h: string;
  trend15m: string;
  trend5m: string;
  trend1m: string;
  contradictions: string[];
  conclusion: string;
};

type ProbabilityEstimate = {
  pYes: number;
  pNo: number;
  confidence: number;
  uncertainty: number;
  reasons: string[];
};

type SimulationSnapshot = {
  currentPrice: number | null;
  points: CryptoChartPoint[];
  targetPrice: number | null;
};

const EMPTY_SIMULATION_SNAPSHOT: SimulationSnapshot = {
  currentPrice: null,
  points: [],
  targetPrice: null,
};

type BotFormState = {
  allowedAssets: BotAsset[];
  fillModel: BotConfig["fillModel"];
  maxDailyRiskPercent: string;
  maxOpenPositions: string;
  maxSpreadPercent: string;
  maxTimeToExpirySeconds: string;
  maxTradesPerDay: string;
  minEdgePercent: string;
  minLiquidityScore: string;
  minTimeToExpirySeconds: string;
  modelMode: BotConfig["modelMode"];
  name: string;
  profile: BotRiskProfile;
  riskPercentPerTrade: string;
  startingBalance: string;
};

type MarketChartProps = {
  compact?: boolean;
  market: PublicMarket;
  priceSeries?: CryptoChartPoint[];
  prices: Record<string, LivePrice>;
  probabilities: BinaryMarketProbabilities;
  targetPrice?: number;
  showSimulationOverlays?: boolean;
  simulationPositions?: SimulatedPosition[];
};

const DEBUG_UI = false;
const PERIODS: PeriodKey[] = ["5m", "15m", "1h", "4h", "24h"];
const TOP_PERIODS: Array<{ label: string; value: TopTraderPeriod }> = [
  { label: "10m", value: "10m" },
  { label: "30m", value: "30m" },
  { label: "1h", value: "1h" },
  { label: "4h", value: "4h" },
  { label: "Jour", value: "day" },
  { label: "Semaine", value: "week" },
  { label: "ALL", value: "all" },
];
const CHART_COLORS = ["#7ddf64", "#ff5d5d", "#67b7ff", "#ffd166"];
const CHART_RANGES: Array<{
  fidelity: number;
  interval: "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h";
  label: string;
  seconds: number;
  value: ChartRangeKey;
}> = [
  { fidelity: 5, interval: "1h", label: "1H", seconds: 60 * 60, value: "1h" },
  { fidelity: 10, interval: "6h", label: "6H", seconds: 6 * 60 * 60, value: "6h" },
  { fidelity: 30, interval: "1d", label: "1D", seconds: 24 * 60 * 60, value: "1d" },
  { fidelity: 120, interval: "1w", label: "1W", seconds: 7 * 24 * 60 * 60, value: "1w" },
  { fidelity: 720, interval: "all", label: "ALL", seconds: 90 * 24 * 60 * 60, value: "all" },
];
const MOTION_STYLE = {
  "--motion-duration-fast": motionSeconds(motionTokens.duration.fast),
  "--motion-duration-normal": motionSeconds(motionTokens.duration.normal),
  "--motion-duration-slow": motionSeconds(motionTokens.duration.slow),
  "--motion-ease-emphasized": cubicBezier(motionTokens.easing.emphasized),
  "--motion-ease-standard": cubicBezier(motionTokens.easing.standard),
} as CSSProperties;
const SIMULATION_STORAGE_KEY = "black-goat-simulation-v1";
const SIMULATION_STORAGE_LIMITS = {
  bots: 30,
  decisions: 180,
  fills: 260,
  orders: 260,
  positions: 260,
  sessions: 60,
};
const SIMULATION_STORAGE_COMPACT_LIMITS = {
  bots: 30,
  decisions: 70,
  fills: 120,
  orders: 120,
  positions: 120,
  sessions: 30,
};
const BOT_ASSETS: BotAsset[] = ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB"];
const BOT_PROFILE_LABELS: Record<BotRiskProfile, string> = {
  opportuniste: "Opportuniste",
  normal: "Normal",
  opening_scenario_bot: "Opening Scenario Bot",
  prudent: "Prudent",
  risquee: "Risquée",
  scalping: "Scalping",
};
const BOT_PRESETS: Record<
  BotRiskProfile,
  Pick<
    BotConfig,
    | "fillModel"
    | "maxDailyRiskPercent"
    | "maxOpenPositions"
    | "maxSpreadPercent"
    | "maxTimeToExpirySeconds"
    | "maxTradesPerDay"
    | "minEdgePercent"
    | "minLiquidityScore"
    | "minTimeToExpirySeconds"
    | "riskPercentPerTrade"
  >
> = {
  normal: {
    fillModel: "realistic",
    maxDailyRiskPercent: 3,
    maxOpenPositions: 3,
    maxSpreadPercent: 3,
    maxTimeToExpirySeconds: 220,
    maxTradesPerDay: 10,
    minEdgePercent: 7,
    minLiquidityScore: 70,
    minTimeToExpirySeconds: 75,
    riskPercentPerTrade: 0.5,
  },
  opportuniste: {
    fillModel: "realistic",
    maxDailyRiskPercent: 3,
    maxOpenPositions: 2,
    maxSpreadPercent: 5,
    maxTimeToExpirySeconds: 220,
    maxTradesPerDay: 15,
    minEdgePercent: 6,
    minLiquidityScore: 55,
    minTimeToExpirySeconds: 60,
    riskPercentPerTrade: 0.75,
  },
  prudent: {
    fillModel: "conservative",
    maxDailyRiskPercent: 1,
    maxOpenPositions: 1,
    maxSpreadPercent: 3,
    maxTimeToExpirySeconds: 240,
    maxTradesPerDay: 5,
    minEdgePercent: 8,
    minLiquidityScore: 75,
    minTimeToExpirySeconds: 90,
    riskPercentPerTrade: 0.25,
  },
  risquee: {
    fillModel: "realistic",
    maxDailyRiskPercent: 4,
    maxOpenPositions: 3,
    maxSpreadPercent: 6,
    maxTimeToExpirySeconds: 260,
    maxTradesPerDay: 20,
    minEdgePercent: 4,
    minLiquidityScore: 45,
    minTimeToExpirySeconds: 45,
    riskPercentPerTrade: 1,
  },
  scalping: {
    fillModel: "conservative",
    maxDailyRiskPercent: 2,
    maxOpenPositions: 1,
    maxSpreadPercent: 3,
    maxTimeToExpirySeconds: 180,
    maxTradesPerDay: 30,
    minEdgePercent: 3,
    minLiquidityScore: 80,
    minTimeToExpirySeconds: 30,
    riskPercentPerTrade: 0.35,
  },
  opening_scenario_bot: {
    fillModel: "conservative",
    maxDailyRiskPercent: 3,
    maxOpenPositions: 3,
    maxSpreadPercent: 4,
    maxTimeToExpirySeconds: 295,
    maxTradesPerDay: 100,
    minEdgePercent: 4,
    minLiquidityScore: 60,
    minTimeToExpirySeconds: 210,
    riskPercentPerTrade: 0.5,
  },
};
const NORMAL_BOT_V2_RULES: BotAdvancedRules = {
  profile: "normal_v2",
  assetRules: {
    BTC: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 0.5, riskMultiplier: 1 },
    ETH: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 0.5, riskMultiplier: 0.9 },
    SOL: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 0.5, riskMultiplier: 0.8 },
    XRP: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 1, riskMultiplier: 0.65 },
    DOGE: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 1, riskMultiplier: 0.65 },
    HYPE: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 1, riskMultiplier: 0.55 },
    BNB: { enabled: true, maxSpreadPercent: 8, minEdgePercent: 1, riskMultiplier: 0.65 },
  },
  dataFreshness: {
    blockIfAnyCriticalDataStale: true,
    maxCryptoPriceAgeMs: 15_000,
    maxMarketMetadataAgeMs: 30_000,
    maxOrderflowAgeMs: 15_000,
    maxPolymarketBookAgeMs: 15_000,
  },
  edge: {
    contradictionPenaltyPercent: 5,
    lowLiquidityPenaltyPercent: 4,
    minEdgePercent: 0.5,
    minEdgePercentForNO: 0.5,
    minEdgePercentForYES: 0.5,
    minEdgeReliability: 0.55,
    staleDataPenaltyPercent: 5,
    uncertaintyPenaltyPercent: 3,
  },
  marketQuality: {
    maxAllowedSlippagePercent: 1.5,
    maxSpreadPercent: 8,
    maxSpreadPercentHighConfidence: 10,
    maxSpreadPercentLowConfidence: 6,
    minFillProbability: 0.8,
    minLiquidityScore: 20,
    minUsdAvailableAtBestAsk: 5,
    minUsdAvailableWithinTwoTicks: 10,
  },
  marketRegime: {
    blockDuringExtremeVolatility: true,
    blockDuringMajorNews: true,
    enabled: true,
    reduceRiskDuringHighVolatility: true,
    riskMultiplierHighVolatility: 0.4,
    riskMultiplierNewsEvent: 0,
    riskMultiplierRange: 0.6,
    riskMultiplierTrend: 1,
  },
  positionLimits: {
    allowPyramiding: false,
    maxCorrelatedPositions: 6,
    maxEntriesPerAssetPerMarket: 1,
    maxEntriesPerMarket: 1,
    maxOpenPositions: 6,
    maxOpenPositionsSameDirection: 6,
  },
  risk: {
    effectiveRiskWarning: true,
    maxConsecutiveLossesBeforePause: 3,
    maxDailyLossUsd: 1.5,
    maxDrawdownBeforePausePercent: 5,
    maxDrawdownBeforeStopPercent: 8,
    maxPositionSizeUsd: 1,
    maxSessionLossUsd: 1,
    minOrderSizeUsd: 1,
    pauseAfterConsecutiveLossesMinutes: 30,
  },
  signalQuality: {
    blockContradictorySignals: true,
    maxContradictionScore: 2,
    minAgreementCount: 1,
    minDirectionalConfidenceToTrade: 0.52,
    minModelConfidenceToTrade: 0.35,
    minSignalScoreToTrade: 35,
    neutralSignalForcesNoTrade: false,
  },
  systemHealth: {
    blockTradingIfClockDriftMsAbove: 500,
    blockTradingIfWebsocketDisconnected: true,
    maxApiErrorRatePercent: 5,
    maxLatencyMs: 750,
    maxWebsocketReconnectsPerHour: 5,
    requireNtpSync: true,
  },
  targetDistance: {
    maxDistanceFromTargetBps: 500,
    maxRequiredMoveToWinPercent: 0.25,
    minDistanceFromTargetBps: 2,
    minVolatilityAdjustedDistance: 0.25,
    useVolatilityAdjustedDistance: true,
  },
  timing: {
    avoidFirstSeconds: 5,
    avoidLastSeconds: 20,
    cooldownAfterLossSeconds: 60,
    cooldownAfterMarketLossSameAssetSeconds: 90,
    cooldownAfterTradeSeconds: 5,
  },
};

export default function App() {
  const [tab, setTab] = useState<Tab>("markets");
  const [route, setRoute] = useState<RouteKey>(() => routeFromPath(window.location.pathname));
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  const [markets, setMarkets] = useState<PublicMarket[]>([]);
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [marketStatus, setMarketStatus] = useState<LiveStatus>("CONNECTING");
  const [marketLatencyMs, setMarketLatencyMs] = useState<number | null>(null);
  const [marketLastUpdate, setMarketLastUpdate] = useState<string | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(true);

  const [period, setPeriod] = useState<PeriodKey>("15m");
  const [sort, setSort] = useState<TraderSort>("profile_quality");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [minTrades, setMinTrades] = useState("");
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [traders, setTraders] = useState<ActiveTrader[]>([]);
  const [liveTrades, setLiveTrades] = useState<NormalizedTrade[]>([]);
  const [tapePaused, setTapePaused] = useState(false);
  const [tradersStatus, setTradersStatus] = useState<LiveStatus>("CONNECTING");
  const [tradersLatencyMs, setTradersLatencyMs] = useState<number | null>(null);
  const [tradersWsMeta, setTradersWsMeta] = useState<TradersWsMeta>({
    lastWsEventAt: null,
    lastTradeEventAt: null,
    newestTradeAt: null,
    secondsSinceLastTradeEvent: null,
    tradesReceivedPerMinute: null,
    wsEventsPerMinute: null,
  });
  const [tradersDataStatus, setTradersDataStatus] = useState<DataSourceStatus>("UNAVAILABLE");
  const [tradersLastUpdate, setTradersLastUpdate] = useState<string | null>(null);
  const [tradersLoading, setTradersLoading] = useState(true);
  const [selectedTraderId, setSelectedTraderId] = useState<string | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<TraderProfileResponse | null>(null);

  const assetIds = useMemo(
    () => Array.from(new Set(markets.flatMap((market) => market.clobTokenIds))).slice(0, 80),
    [markets],
  );
  const featuredMarketKey = markets[0]?.slug ?? markets[0]?.id ?? markets[0]?.question ?? null;

  const resetMarketState = useCallback(() => {
    setPrices({});
    setMarketLatencyMs(null);
    setMarketLastUpdate(null);
    setMarketStatus("CONNECTING");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handlePopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((nextRoute: RouteKey) => {
    const nextPath = pathForRoute(nextRoute);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setRoute(nextRoute);
  }, []);

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/polymarket/markets?limit=10");
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
    const timer = window.setInterval(() => {
      void loadMarkets();
    }, 30_000);

    return () => window.clearInterval(timer);
  }, [loadMarkets]);

  useEffect(() => {
    resetMarketState();
  }, [featuredMarketKey, resetMarketState]);

  useEffect(() => {
    const featuredMarket = markets[0];
    if (featuredMarket?.endDate === null || featuredMarket?.endDate === undefined) {
      return;
    }

    const endMs = Date.parse(featuredMarket.endDate);
    if (Number.isNaN(endMs)) {
      return;
    }

    const delayMs = Math.max(250, endMs - Date.now() + 8_000);
    const timer = window.setTimeout(() => {
      resetMarketState();
      void loadMarkets();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [loadMarkets, markets, resetMarketState]);

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

        if (message.type === "market_event") {
          const eventType = readString(message.eventType);
          if (eventType === "market_resolved" || eventType === "new_market") {
            resetMarketState();
            void loadMarkets();
          }
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
  }, [assetIds, loadMarkets, resetMarketState]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) {
        return;
      }

      setTradersStatus("CONNECTING");
      const query = new URLSearchParams({ period, sort });
      if (search.trim().length > 0) {
        query.set("search", search.trim());
      }
      if (minVolume.trim().length > 0) {
        query.set("minVolume", minVolume.trim());
      }
      if (minTrades.trim().length > 0) {
        query.set("minTrades", minTrades.trim());
      }

      socket = new WebSocket(buildWebSocketUrl(`/ws/traders?${query.toString()}`));

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
          setTradersWsMeta(readTradersWsMeta(message));
          return;
        }

        if (message.type === "trades") {
          const trades = Array.isArray(message.trades) ? message.trades.filter(isNormalizedTrade) : [];
          const incomingTraders = Array.isArray(message.traders) ? message.traders.filter(isActiveTrader) : [];
          if (incomingTraders.length > 0) {
            setTraders(incomingTraders);
            setTradersLoading(false);
          }
          if (!tapePaused && trades.length > 0) {
            setLiveTrades((current) => mergeTrades(trades, current).slice(0, 50));
          }
          setTradersDataStatus(readDataSourceStatus(message.dataSourceStatus));
          setTradersLastUpdate(readString(message.time) ?? new Date().toISOString());
          setTradersWsMeta(readTradersWsMeta(message));
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
  }, [minTrades, minVolume, period, search, sort, tapePaused]);

  const traderRouteStatus = deriveTraderLiveStatus(tradersStatus, tradersWsMeta, nowMs);
  const tradersDetail = formatTraderWsDetail(tradersWsMeta, nowMs);

  return (
    <main className="app-shell motion-root" style={MOTION_STYLE}>
      <SiteNav
        activeRoute={route}
        marketStatus={marketStatus}
        onNavigate={navigate}
        tradersDetail={tradersDetail}
        tradersStatus={traderRouteStatus}
      />
      <div className="page-content">
        <div aria-live="polite" className={`app-status-toast ${error !== null ? "visible" : ""}`}>
          {error !== null ? `API unavailable or returned an error: ${error}` : ""}
        </div>
        {route === "markets" ? (
          <DashboardView
            assetIds={assetIds}
            lastUpdate={marketLastUpdate}
            loading={marketsLoading}
            marketLatencyMs={marketLatencyMs}
            marketStatus={marketStatus}
            markets={markets}
            nowMs={nowMs}
            onRefresh={loadMarkets}
            prices={prices}
            tradersDetail={tradersDetail}
            tradersLatencyMs={tradersLatencyMs}
            tradersStatus={traderRouteStatus}
          />
        ) : null}
        {route === "simulation-bot" ? (
          <SimulationBotView markets={markets} nowMs={nowMs} prices={prices} />
        ) : null}
        {route === "opening-scenario-bot" ? (
          <SimulationBotView markets={markets} nowMs={nowMs} openingFocused prices={prices} />
        ) : null}
        {route === "top-traders" ? <TopTradersView nowMs={nowMs} /> : null}
        {route === "settings" ? <SettingsView /> : null}
      </div>
    </main>
  );
}

function SiteNav({
  activeRoute,
  marketStatus,
  onNavigate,
  tradersDetail,
  tradersStatus,
}: {
  activeRoute: RouteKey;
  marketStatus: LiveStatus;
  onNavigate: (route: RouteKey) => void;
  tradersDetail: string;
  tradersStatus: LiveStatus;
}) {
  const navItems: Array<{ label: string; route: RouteKey }> = [
    { label: "Marchés", route: "markets" },
    { label: "Simulation Bot", route: "simulation-bot" },
    { label: "Opening Scenario", route: "opening-scenario-bot" },
    { label: "Top Traders", route: "top-traders" },
    { label: "Settings", route: "settings" },
  ];

  return (
    <header className="site-nav">
      <button className="site-logo" onClick={() => onNavigate("markets")} type="button">
        BLACK-GOAT
      </button>
      <nav aria-label="Navigation principale" className="site-links">
        {navItems.map((item) => (
          <button
            className={activeRoute === item.route ? "active" : ""}
            key={item.route}
            onClick={() => onNavigate(item.route)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="nav-status">
        <StatusPanel detail={marketStatus === "LIVE" ? "live" : undefined} label="Markets WS" latencyMs={null} status={marketStatus} />
        <StatusPanel detail={tradersDetail} label="Traders WS" latencyMs={null} status={tradersStatus} />
      </div>
    </header>
  );
}

function SettingsView() {
  return (
    <section className="settings-page">
      <div className="page-title-row">
        <div>
          <p className="eyebrow">BLACK-GOAT</p>
          <h1>Settings</h1>
          <p>Sources publiques en lecture seule, préférences UI et debug séparé.</p>
        </div>
      </div>
      <div className="settings-grid">
        <article>
          <span>Mode</span>
          <strong>TEST read-only</strong>
          <p>Aucun wallet utilisateur, aucune clé privée, aucun endpoint de trading.</p>
        </article>
        <article>
          <span>Sources</span>
          <strong>Gamma API / Data API / CLOB read / RTDS</strong>
          <p>Les données affichées restent publiques et non authentifiées.</p>
        </article>
        <article>
          <span>Simulation</span>
          <strong>localStorage V1</strong>
          <p>Les bots, décisions et positions paper sont stockés localement sur ce navigateur.</p>
        </article>
      </div>
    </section>
  );
}

function StatusPanel({
  detail,
  label,
  latencyMs,
  status,
}: {
  detail?: string;
  label: string;
  latencyMs: number | null;
  status: LiveStatus;
}) {
  return (
    <div className="status-panel">
      <span className={`status-dot ${status.toLowerCase()}`} />
      <span className="status-label">{label}</span>
      <strong>{status}</strong>
      <span className="latency">{detail ?? (DEBUG_UI ? formatLatency(latencyMs) : "")}</span>
    </div>
  );
}

function DashboardView({
  assetIds,
  lastUpdate,
  loading,
  marketLatencyMs,
  marketStatus,
  markets,
  nowMs,
  onRefresh,
  prices,
  tradersDetail,
  tradersLatencyMs,
  tradersStatus,
}: {
  assetIds: string[];
  lastUpdate: string | null;
  loading: boolean;
  marketLatencyMs: number | null;
  marketStatus: LiveStatus;
  markets: PublicMarket[];
  nowMs: number;
  onRefresh: () => Promise<void>;
  prices: Record<string, LivePrice>;
  tradersDetail: string;
  tradersLatencyMs: number | null;
  tradersStatus: LiveStatus;
}) {
  const cryptoMarkets = useMemo(() => {
    const filtered = markets.filter(isCryptoUpDownMarket);
    return filtered.length > 0 ? filtered : markets;
  }, [markets]);
  const [selectedCryptoIndex, setSelectedCryptoIndex] = useState(0);
  const swipeStartX = useRef<number | null>(null);
  const featuredMarket = cryptoMarkets[selectedCryptoIndex] ?? cryptoMarkets[0] ?? null;
  const cardMarkets = cryptoMarkets.filter((_, index) => index !== selectedCryptoIndex).slice(0, 4);
  const selectedMarketKey = featuredMarket?.slug ?? featuredMarket?.id ?? featuredMarket?.question ?? "market";

  useEffect(() => {
    setSelectedCryptoIndex((current) => (cryptoMarkets.length === 0 ? 0 : Math.min(current, cryptoMarkets.length - 1)));
  }, [cryptoMarkets.length]);

  const goToMarket = useCallback(
    (direction: -1 | 1) => {
      setSelectedCryptoIndex((current) => {
        if (cryptoMarkets.length <= 1) {
          return 0;
        }

        return (current + direction + cryptoMarkets.length) % cryptoMarkets.length;
      });
    },
    [cryptoMarkets.length],
  );

  const handleSwipeStart = (event: PointerEvent<HTMLDivElement>) => {
    swipeStartX.current = event.clientX;
  };

  const handleSwipeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (swipeStartX.current === null) {
      return;
    }

    const deltaX = event.clientX - swipeStartX.current;
    swipeStartX.current = null;
    if (Math.abs(deltaX) < 48) {
      return;
    }

    goToMarket(deltaX < 0 ? 1 : -1);
  };

  return (
    <section className="polymarket-dashboard">
      <div className="dashboard-main">
        <div className="dashboard-status-slot" aria-live="polite">
          {loading ? <span>Refreshing markets</span> : null}
        </div>
        {featuredMarket === null ? (
          <section className="featured-market-card market-placeholder">
            <p>{loading ? "Loading markets..." : "No markets returned."}</p>
          </section>
        ) : (
          <div className="crypto-swipe-stage" onPointerDown={handleSwipeStart} onPointerUp={handleSwipeEnd}>
            <FeaturedMarketCard key={selectedMarketKey} market={featuredMarket} onRefresh={onRefresh} prices={prices} />
            {cryptoMarkets.length > 1 ? (
              <div className="crypto-swipe-controls" aria-label="Crypto chart navigation">
                <button aria-label="Previous crypto chart" onClick={() => goToMarket(-1)} type="button">
                  ‹
                </button>
                <div className="crypto-swipe-dots">
                  {cryptoMarkets.map((market, index) => (
                    <button
                      aria-label={`Show ${inferCryptoChartLabel(market)} chart`}
                      className={index === selectedCryptoIndex ? "active" : ""}
                      key={market.slug ?? market.id ?? market.question ?? index}
                      onClick={() => setSelectedCryptoIndex(index)}
                      type="button"
                    >
                      {inferCryptoChartLabel(market)}
                    </button>
                  ))}
                </div>
                <button aria-label="Next crypto chart" onClick={() => goToMarket(1)} type="button">
                  ›
                </button>
              </div>
            ) : null}
          </div>
        )}

        <div className="market-carousel">
          {cardMarkets.map((market, index) => (
            <MiniMarketCard
              key={market.id ?? market.slug ?? market.question ?? index}
              market={market}
              onSelect={() => {
                const targetIndex = cryptoMarkets.findIndex((item) => (item.slug ?? item.id ?? item.question) === (market.slug ?? market.id ?? market.question));
                if (targetIndex >= 0) {
                  setSelectedCryptoIndex(targetIndex);
                }
              }}
              prices={prices}
            />
          ))}
        </div>
      </div>

      <aside className="dashboard-sidebar">
        <ReadOnlyPortfolioCard
          assetCount={assetIds.length}
          lastUpdate={lastUpdate}
          marketLatencyMs={marketLatencyMs}
          marketStatus={marketStatus}
          tradersDetail={tradersDetail}
          tradersLatencyMs={tradersLatencyMs}
          tradersStatus={tradersStatus}
        />
        <TopTraderCard compact nowMs={nowMs} />
      </aside>
    </section>
  );
}

function ReadOnlyPortfolioCard({
  assetCount,
  lastUpdate,
  marketLatencyMs,
  marketStatus,
  tradersDetail,
  tradersLatencyMs,
  tradersStatus,
}: {
  assetCount: number;
  lastUpdate: string | null;
  marketLatencyMs: number | null;
  marketStatus: LiveStatus;
  tradersDetail: string;
  tradersLatencyMs: number | null;
  tradersStatus: LiveStatus;
}) {
  return (
    <section className="side-card read-only-card">
      <div className="wallet-strip">
        <div>
          <span>Portefeuille</span>
          <strong>Read-only</strong>
        </div>
        <div>
          <span>Espèces</span>
          <strong>$0.00</strong>
        </div>
        <button type="button">TEST</button>
      </div>
      <div className="profit-card">
        <span className="loss-label">Profit/Loss</span>
        <strong>$0.00</strong>
        <small>Données portefeuille non connectées</small>
      </div>
      <div className="live-strip">
        <StatusPanel detail={marketStatus === "LIVE" ? "connected" : undefined} label="Markets WS" latencyMs={marketLatencyMs} status={marketStatus} />
        <StatusPanel detail={tradersDetail} label="Traders WS" latencyMs={tradersLatencyMs} status={tradersStatus} />
      </div>
      {DEBUG_UI ? <p>{assetCount} assets publics suivis | update {formatTime(lastUpdate)}</p> : null}
    </section>
  );
}

function FeaturedMarketCard({
  compact = false,
  market,
  onRefresh,
  prices,
  showMarketProbability = true,
  showSimulationOverlays = false,
  simulationPositions = [],
}: {
  compact?: boolean;
  market: PublicMarket;
  onRefresh: () => Promise<void>;
  prices: Record<string, LivePrice>;
  showMarketProbability?: boolean;
  showSimulationOverlays?: boolean;
  simulationPositions?: SimulatedPosition[];
}) {
  const [frozenOutcomePrices, setFrozenOutcomePrices] = useState<Record<string, LivePrice> | null>(null);
  const title = market.question ?? "Untitled market";
  const marketUrl = market.slug === null ? null : `https://polymarket.com/event/${market.slug}`;
  const marketEndMs = market.endDate === null ? null : Date.parse(market.endDate);
  const shouldFreezeOutcomes = marketEndMs !== null && !Number.isNaN(marketEndMs) && Date.now() >= marketEndMs;
  const displayPrices = shouldFreezeOutcomes ? (frozenOutcomePrices ?? prices) : prices;
  const primaryOutcomes = market.outcomes.slice(0, 4).map((outcome, index) => ({
    outcome,
    quote: getOutcomeQuote(market, displayPrices, index),
  }));
  const category = inferMarketCategory(title);
  const description = buildMarketDescription(primaryOutcomes);
  const schema = buildMarketSchema(title, description, marketUrl);
  const imageUrl = market.icon ?? market.image;
  const displayProbability = getDisplayProbability(market, displayPrices);

  useEffect(() => {
    setFrozenOutcomePrices(null);
  }, [market.slug]);

  useEffect(() => {
    if (shouldFreezeOutcomes && frozenOutcomePrices === null) {
      setFrozenOutcomePrices(prices);
    }
  }, [frozenOutcomePrices, prices, shouldFreezeOutcomes]);

  return (
    <figure
      aria-label={`Polymarket prediction market: ${title}`}
      className={`featured-market-card polymarket-embed-rebuild${compact ? " compact-market-card" : ""}`}
      itemScope
      itemType="https://schema.org/WebPage"
    >
      <script
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(schema),
        }}
        type="application/ld+json"
      />
      <div className="featured-head">
        <div className="featured-title-wrap">
          <div className="featured-icon" aria-hidden="true">
            {imageUrl === null ? getInitials(category) : <img alt="" src={imageUrl} />}
          </div>
          <div>
            <p className="featured-kicker">
              {category} · {market.sourceType === "CURATED_LIVE_CRYPTO" ? "5m Live" : "Public market"}
            </p>
            <h1 itemProp="name">{title}</h1>
          </div>
        </div>
        <div className="featured-actions">
          <button onClick={() => void onRefresh()} type="button">
            Refresh
          </button>
          {marketUrl !== null ? (
            <a aria-label="View on Polymarket" href={marketUrl} itemProp="url" rel="noreferrer" target="_blank">
              View
            </a>
          ) : null}
        </div>
      </div>

      <div className="featured-body">
        {compact ? null : (
          <aside className={`price-ladder${showMarketProbability ? "" : " without-probability"}`} aria-label="Outcome prices">
            {showMarketProbability ? (
              <div className="binary-probability-card">
                <span>Market Probability</span>
                {displayProbability.upProbability === null ? (
                  <strong>Waiting for orderbook</strong>
                ) : (
                  <AnimatedValue
                    className="probability-value"
                    formatter={(value) => `Up ${formatPercent(value)} / Down ${formatPercent(100 - value)}`}
                    tag="strong"
                    value={displayProbability.upProbability}
                  />
                )}
                {DEBUG_UI ? <small>{displayProbability.source}</small> : null}
              </div>
            ) : null}
            {primaryOutcomes.map(({ outcome, quote }, index) => (
              <div className="price-level" key={`${quote.assetId}-${outcome}-${index}`}>
                <span title={outcome}>{outcome}</span>
                <AnimatedValue formatter={formatCents} tag="strong" value={quote.displayPrice} />
                {DEBUG_UI ? <small>{quote.eventType}</small> : null}
              </div>
            ))}
          </aside>
        )}

        <div className="featured-chart">
          {DEBUG_UI ? <div className="featured-legend">
            {primaryOutcomes.map(({ outcome, quote }, index) => (
              <span key={`${quote.assetId}-legend-${outcome}`} title={outcome}>
                <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                {outcome} {formatProbability(quote.displayPrice)}
              </span>
            ))}
          </div> : null}
          <MarketChart
            compact={compact}
            market={market}
            prices={displayPrices}
            probabilities={displayProbability}
            showSimulationOverlays={showSimulationOverlays}
            simulationPositions={showSimulationOverlays ? simulationPositions : []}
          />
        </div>
      </div>

      <div className="featured-footer">
        <span>{formatUsd(market.volume24hr)} Vol 24h</span>
        <span>{formatUsd(market.liquidity)} liquidity</span>
        {market.priceToBeat !== null ? <span>Price to beat {formatUsd(market.priceToBeat)}</span> : null}
        {market.endDate !== null ? <span>Ends {formatTime(market.endDate)}</span> : null}
        <span>{market.acceptingOrders ? "Public orderbook" : "Read-only view"}</span>
        <SourceBadge compact status="REAL POLYMARKET DATA" />
      </div>
      <figcaption className="sr-only">
        <strong>{title}</strong>
        <br />
        {description}
        <br />
        {marketUrl !== null ? <a href={marketUrl}>View full market on Polymarket</a> : null}
      </figcaption>
    </figure>
  );
}

function MiniMarketCard({
  market,
  onSelect,
  prices,
}: {
  market: PublicMarket;
  onSelect?: () => void;
  prices: Record<string, LivePrice>;
}) {
  const firstQuote = getOutcomeQuote(market, prices, 0);
  const secondQuote = getOutcomeQuote(market, prices, 1);
  const marketUrl = market.slug === null ? null : `https://polymarket.com/event/${market.slug}`;
  const title = market.question ?? "Untitled market";
  const primaryOutcome = market.outcomes[0] ?? "Outcome";
  const secondaryOutcome = market.outcomes[1] ?? "Other";
  const imageUrl = market.icon ?? market.image;

  return (
    <article
      className={`mini-market-card ${onSelect === undefined ? "" : "selectable"}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (onSelect !== undefined && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      role={onSelect === undefined ? undefined : "button"}
      tabIndex={onSelect === undefined ? undefined : 0}
    >
      <div className="mini-market-head">
        <div className="mini-token" aria-hidden="true">
          {imageUrl === null ? getInitials(primaryOutcome) : <img alt="" src={imageUrl} />}
        </div>
        <div>
          {marketUrl === null ? (
            <h2>{title}</h2>
          ) : (
            <a href={marketUrl} rel="noreferrer" target="_blank">
              {title}
            </a>
          )}
          <span>{formatOptionalMarketValue(market.volume24hr, "Vol")}</span>
        </div>
        <strong>{formatProbability(firstQuote.displayPrice)}</strong>
      </div>

      <div className="mini-price-grid" aria-label="Read-only outcome prices">
        <span className="up" title={primaryOutcome}>
          {primaryOutcome} {formatProbability(firstQuote.displayPrice)}
        </span>
        <span className="down" title={secondaryOutcome}>
          {secondaryOutcome} {formatProbability(secondQuote.displayPrice)}
        </span>
      </div>

      <div className="mini-market-foot">
        <span>{firstQuote.eventType === "snapshot" ? "SNAPSHOT" : "LIVE"}</span>
        <span>{market.endDate === null ? formatOptionalMarketValue(market.liquidity, "liquidity") : `Ends ${formatTime(market.endDate)}`}</span>
      </div>
    </article>
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

function TopTraderCard({ compact = false, nowMs }: { compact?: boolean; nowMs: number }) {
  const [period, setPeriod] = useState<TopTraderPeriod>("10m");
  const [sort] = useState<TopTraderSort>("globalScore");
  const [traders, setTraders] = useState<TopTrader[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoadingUi, setShowLoadingUi] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTopTraders = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const query = new URLSearchParams({
        limit: "5",
        period,
        sort,
      });
      const response = await fetch(`/api/polymarket/top-traders?${query.toString()}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as TopTradersResponse;
      setTraders((payload.traders ?? []).slice(0, 5));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setLoading(false);
    }
  }, [period, sort]);

  useEffect(() => {
    void loadTopTraders();
    const timer = window.setInterval(() => {
      void loadTopTraders();
    }, 10_000);

    return () => window.clearInterval(timer);
  }, [loadTopTraders]);

  useEffect(() => {
    if (!loading) {
      setShowLoadingUi(false);
      return;
    }

    const timer = window.setTimeout(() => setShowLoadingUi(true), 200);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return (
    <article className={`top-trader-card ${compact ? "compact-card" : ""}`}>
      <div className="top-trader-head">
        <div>
          <h2>Top Trader</h2>
          {!compact ? <p>Top 5 profils publics Polymarket, lecture seule.</p> : null}
        </div>
        <div className="period-pills" aria-label="Top Trader periods">
          {TOP_PERIODS.map((item) => (
            <button
              className={period === item.value ? "active" : ""}
              key={item.value}
              onClick={() => setPeriod(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="top-trader-status" aria-live="polite">
        {error !== null ? <span title={`Top Trader API error: ${error}`}>API stale</span> : null}
        {error === null && showLoadingUi ? <span>{traders.length > 0 ? "Refreshing" : "Loading"}</span> : null}
      </div>

      <div className={`top-trader-list ${loading ? "is-refreshing" : ""}`}>
        {traders.length === 0
          ? Array.from({ length: 5 }).map((_, index) => (
              <div className={`top-trader-row top-trader-skeleton ${showLoadingUi ? "is-visible" : ""}`} key={`top-trader-skeleton-${index}`}>
                <span className="top-rank">#{index + 1}</span>
                <div className="top-avatar" />
                <div className="top-identity">
                  <span>{showLoadingUi ? "Loading" : ""}</span>
                  <span>{showLoadingUi ? "Public Polymarket data" : ""}</span>
                </div>
                <div className="top-metric">
                  <strong>--</strong>
                  <span>Score</span>
                </div>
                <span className="top-pnl neutral">--</span>
              </div>
            ))
          : traders.map((trader) => (
              <TopTraderRow compact={compact} key={`${period}-${trader.wallet}`} nowMs={nowMs} sort={sort} trader={trader} />
            ))}
      </div>
    </article>
  );
}

function TopTradersView({ nowMs }: { nowMs: number }) {
  return (
    <section className="top-trader-page">
      <TopTraderCard nowMs={nowMs} />
    </section>
  );
}

function SimulationBotView({
  markets,
  nowMs,
  openingFocused = false,
  prices,
}: {
  markets: PublicMarket[];
  nowMs: number;
  openingFocused?: boolean;
  prices: Record<string, LivePrice>;
}) {
  const cryptoMarkets = useMemo(
    () => markets.filter((market) => isCryptoUpDownMarket(market) && getBotAssetForMarket(market) !== null),
    [markets],
  );
  const [activeAsset, setActiveAsset] = useState<BotAsset>("BTC");
  const activeMarket =
    cryptoMarkets.find((market) => getBotAssetForMarket(market) === activeAsset) ??
    cryptoMarkets.find((market) => getBotAssetForMarket(market) !== null) ??
    null;
  const [bots, setBots] = useState<BotConfig[]>(() => simulationStorage.getBots());
  const [positions, setPositions] = useState<SimulatedPosition[]>(() => simulationStorage.getPositions());
  const [decisions, setDecisions] = useState<BotDecision[]>(() => simulationStorage.getDecisions());
  const [sessions, setSessions] = useState<SimulationSession[]>(() => simulationStorage.getSessions());
  const [orders, setOrders] = useState<PaperOrder[]>(() => simulationStorage.getOrders());
  const [fills, setFills] = useState<PaperFill[]>(() => simulationStorage.getFills());
  const [selectedBotId, setSelectedBotId] = useState<string | null>(() => simulationStorage.getBots()[0]?.id ?? null);
  const [showAddBot, setShowAddBot] = useState(false);
  const activeBot = bots.find((bot) => bot.id === selectedBotId) ?? bots[0] ?? null;
  const [showPositions, setShowPositions] = useState(true);
  const [form, setForm] = useState<BotFormState>(() => createBotFormState(openingFocused ? "opening_scenario_bot" : "normal"));
  const [openingSettings, setOpeningSettings] = useState<OpeningScenarioSettings>(() => DEFAULT_OPENING_SCENARIO_SETTINGS);
  const [openingSettingsStatus, setOpeningSettingsStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const assignedBotMarkets = useMemo(() => getAssignedBotMarkets(cryptoMarkets, activeBot), [activeBot, cryptoMarkets]);
  const runningAssignedBotMarkets = useMemo(
    () => dedupeMarkets(bots.filter((bot) => bot.status === "running").flatMap((bot) => getAssignedBotMarkets(cryptoMarkets, bot))),
    [bots, cryptoMarkets],
  );
  const simulationChartMarkets = useMemo(
    () => getSimulationChartMarkets(cryptoMarkets, activeBot, activeAsset, 6, nowMs),
    [activeAsset, activeBot, cryptoMarkets, nowMs],
  );
  const trackedSimulationMarkets = useMemo(
    () => dedupeMarkets([activeMarket, ...simulationChartMarkets, ...assignedBotMarkets, ...runningAssignedBotMarkets]),
    [activeMarket, assignedBotMarkets, runningAssignedBotMarkets, simulationChartMarkets],
  );
  const simulationSnapshots = useSimulationSnapshots(trackedSimulationMarkets);
  const snapshot = activeMarket === null ? EMPTY_SIMULATION_SNAPSHOT : simulationSnapshots[getMarketKey(activeMarket)] ?? EMPTY_SIMULATION_SNAPSHOT;
  const simulationTick = Math.floor(nowMs / 5_000);
  const lastSimulationRunRef = useRef<string | null>(null);
  const getVisiblePositionsForMarket = (market: PublicMarket) => {
    if (activeBot === null) {
      return [];
    }

    const marketId = getMarketKey(market);
    return positions.filter((position) => position.botId === activeBot.id && position.marketId === marketId);
  };
  const activeBotPositions = activeBot === null ? [] : positions.filter((position) => position.botId === activeBot.id);
  const activeBotDecisions = activeBot === null ? [] : decisions.filter((decision) => decision.botId === activeBot.id);
  const activeBotSessions = activeBot === null ? [] : sessions.filter((session) => session.botId === activeBot.id);
  const activeBotOrders = activeBot === null ? [] : orders.filter((order) => order.botId === activeBot.id);
  const activeBotFills = activeBot === null ? [] : fills.filter((fill) => fill.botId === activeBot.id);
  const stats = activeBot === null ? null : calculatePerformanceStats(activeBot, activeBotPositions, activeBotDecisions);
  const activeDecision = activeBotDecisions[0] ?? null;
  const dailyAnalysis = buildDailyAnalysis(activeAsset, snapshot, nowMs);
  const mtfAnalysis = buildMultiTimeframeAnalysis(activeAsset, snapshot);

  useEffect(() => {
    simulationStorage.save({ bots, decisions, fills, orders, positions, sessions });
  }, [bots, decisions, fills, orders, positions, sessions]);

  useEffect(() => {
    let stopped = false;
    const loadOpeningSettings = async () => {
      try {
        const response = await fetch("/api/bots/opening-scenario/settings");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as OpeningScenarioSettings;
        if (!stopped) {
          setOpeningSettings({ ...DEFAULT_OPENING_SCENARIO_SETTINGS, ...payload });
        }
      } catch {
        if (!stopped) {
          setOpeningSettingsStatus("error");
        }
      }
    };
    void loadOpeningSettings();
    return () => {
      stopped = true;
    };
  }, []);

  const saveOpeningSettings = useCallback(async (patch: Partial<OpeningScenarioSettings>) => {
    const nextSettings = { ...openingSettings, ...patch };
    setOpeningSettings(nextSettings);
    setOpeningSettingsStatus("saving");
    try {
      const response = await fetch("/api/bots/opening-scenario/settings", {
        body: JSON.stringify(nextSettings),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as OpeningScenarioSettings;
      setOpeningSettings({ ...DEFAULT_OPENING_SCENARIO_SETTINGS, ...payload });
      setOpeningSettingsStatus("saved");
    } catch {
      setOpeningSettingsStatus("error");
    }
  }, [openingSettings]);

  useEffect(() => {
    if (selectedBotId !== null && bots.some((bot) => bot.id === selectedBotId)) {
      return;
    }
    setSelectedBotId(bots[0]?.id ?? null);
  }, [bots, selectedBotId]);

  useEffect(() => {
    if (activeMarket !== null) {
      const marketAsset = getBotAssetForMarket(activeMarket);
      if (marketAsset !== null && marketAsset !== activeAsset) {
        setActiveAsset(marketAsset);
      }
    }
  }, [activeAsset, activeMarket]);

  useEffect(() => {
    const runningBots = bots.filter((bot) => bot.status === "running");
    if (runningBots.length === 0 || cryptoMarkets.length === 0) {
      return;
    }

    const runningSignature = runningBots
      .map((bot) => `${bot.id}:${getAssignedBotMarkets(cryptoMarkets, bot).map(getMarketKey).join(",")}`)
      .join("|");
    const runKey = `${simulationTick}:${runningSignature}`;
    if (lastSimulationRunRef.current === runKey) {
      return;
    }
    lastSimulationRunRef.current = runKey;

    let nextPositions = positions;
    let nextSessions = sessions;
    let nextDecisions = decisions;
    let nextBots = bots;
    const producedDecisions: BotDecision[] = [];
    const producedOrders: PaperOrder[] = [];
    const producedFills: PaperFill[] = [];

    for (const runningBot of runningBots) {
      let nextBot = nextBots.find((bot) => bot.id === runningBot.id) ?? runningBot;
      const botMarkets = getAssignedBotMarkets(cryptoMarkets, nextBot);
      if (botMarkets.length === 0) {
        continue;
      }
      let nextSession = nextSessions.find((session) => session.botId === nextBot.id && session.status === "running") ?? null;

      for (const market of botMarkets) {
        const asset = getBotAssetForMarket(market);
        if (asset === null) {
          continue;
        }

        const marketSnapshot = simulationSnapshots[getMarketKey(market)] ?? EMPTY_SIMULATION_SNAPSHOT;
        const result = runPaperTradingTick({
          bot: nextBot,
          dailyAnalysis: buildDailyAnalysis(asset, marketSnapshot, nowMs),
          decisions: nextDecisions,
          market,
          mtfAnalysis: buildMultiTimeframeAnalysis(asset, marketSnapshot),
          openingScenarioSettings: openingSettings,
          positions: nextPositions,
          prices,
          session: nextSession,
          snapshot: marketSnapshot,
          nowMs,
        });

        nextPositions = result.positions;
        nextBot = result.updatedBot;
        nextSession = result.session ?? nextSession;
        if (result.decision !== null) {
          producedDecisions.push(result.decision);
          nextDecisions = [result.decision, ...nextDecisions];
        }
        if (result.order !== null) {
          producedOrders.push(result.order);
        }
        if (result.fill !== null) {
          producedFills.push(result.fill);
        }
      }

      if (nextSession !== null) {
        nextSessions = upsertSimulationSession(nextSessions, nextSession);
      }
      if (nextBot !== runningBot) {
        nextBots = nextBots.map((bot) => (bot.id === runningBot.id ? nextBot : bot));
      }
    }

    if (nextPositions !== positions) {
      setPositions(nextPositions);
    }
    if (nextSessions !== sessions) {
      setSessions(nextSessions);
    }
    if (producedOrders.length > 0) {
      setOrders((current) => [...producedOrders, ...current].slice(0, SIMULATION_STORAGE_LIMITS.orders));
    }
    if (producedFills.length > 0) {
      setFills((current) => [...producedFills, ...current].slice(0, SIMULATION_STORAGE_LIMITS.fills));
    }
    if (producedDecisions.length > 0) {
      setDecisions((current) => [...producedDecisions, ...current].slice(0, SIMULATION_STORAGE_LIMITS.decisions));
    }
    if (nextBots !== bots) {
      setBots(nextBots);
    }
  }, [bots, cryptoMarkets, decisions, openingSettings, positions, prices, sessions, simulationSnapshots, simulationTick]);

  const createBot = () => {
    const bot = createBotFromForm(form);
    setBots((current) => [...current, bot]);
    setSelectedBotId(bot.id);
    setShowAddBot(false);
    setForm(createBotFormState(form.profile));
  };

  const updateActiveBot = (patch: Partial<BotConfig>) => {
    if (activeBot === null) {
      return;
    }
    setBots((current) => current.map((bot) => (bot.id === activeBot.id ? { ...bot, ...patch } : bot)));
  };

  const pauseActiveBot = () => {
    if (activeBot === null) {
      return;
    }
    const endedAt = Date.now();
    setSessions((current) =>
      current.map((session) =>
        session.botId === activeBot.id && session.status === "running"
          ? {
              ...session,
              endedAt,
              endingBalance: stats?.currentBalance ?? activeBot.currentBalance,
              status: "paused",
              notes: Array.from(new Set([...session.notes, "session paused by user"])),
            }
          : session,
      ),
    );
    updateActiveBot({ status: "paused" });
  };

  const resumeActiveBot = () => {
    if (activeBot === null) {
      return;
    }
    const session = createSimulationSession(activeBot, assignedBotMarkets[0] ?? activeMarket);
    setSessions((current) => [session, ...current.map((item) => (item.botId === activeBot.id && item.status === "running" ? { ...item, status: "paused" as const, endedAt: Date.now() } : item))]);
    updateActiveBot({ status: "running" });
  };

  const duplicateActiveBot = () => {
    if (activeBot === null) {
      return;
    }
    const duplicate = {
      ...activeBot,
      currentBalance: activeBot.startingBalance,
      id: makeId("bot"),
      name: `${activeBot.name} Copy`,
      status: "paused" as BotStatus,
      createdAt: Date.now(),
    };
    setBots((current) => [...current, duplicate]);
    setSelectedBotId(duplicate.id);
  };

  const resetActiveBot = () => {
    if (activeBot === null) {
      return;
    }
    setPositions((current) => current.filter((position) => position.botId !== activeBot.id));
    setDecisions((current) => current.filter((decision) => decision.botId !== activeBot.id));
    setOrders((current) => current.filter((order) => order.botId !== activeBot.id));
    setFills((current) => current.filter((fill) => fill.botId !== activeBot.id));
    setSessions((current) => current.filter((session) => session.botId !== activeBot.id));
    updateActiveBot({ currentBalance: activeBot.startingBalance, status: "paused" });
  };

  const deleteBotById = (botId: string) => {
    const botToDelete = bots.find((bot) => bot.id === botId);
    if (botToDelete === undefined) {
      return;
    }
    const shouldDelete = window.confirm(`Supprimer ${botToDelete.name} et son historique local ?`);
    if (!shouldDelete) {
      return;
    }

    const nextBots = bots.filter((bot) => bot.id !== botId);
    const nextPositions = positions.filter((position) => position.botId !== botId);
    const nextDecisions = decisions.filter((decision) => decision.botId !== botId);
    const nextOrders = orders.filter((order) => order.botId !== botId);
    const nextFills = fills.filter((fill) => fill.botId !== botId);
    const nextSessions = sessions.filter((session) => session.botId !== botId);

    setSelectedBotId(selectedBotId === botId ? nextBots[0]?.id ?? null : selectedBotId);
    setBots(nextBots);
    setPositions(nextPositions);
    setDecisions(nextDecisions);
    setOrders(nextOrders);
    setFills(nextFills);
    setSessions(nextSessions);
    simulationStorage.save({
      bots: nextBots,
      decisions: nextDecisions,
      fills: nextFills,
      orders: nextOrders,
      positions: nextPositions,
      sessions: nextSessions,
    });
  };

  const deleteActiveBot = () => {
    if (activeBot === null) {
      return;
    }
    deleteBotById(activeBot.id);
  };

  return (
    <section className="simulation-page">
      <div className="simulation-hero">
        <div>
          <p className="eyebrow">Paper trading local</p>
          <h1>{openingFocused ? "Opening Scenario Bot" : "Simulation Bot"}</h1>
          <p>
            {openingFocused
              ? "Bot specialise dans l'ouverture des marches 5m: 3 scenarios, forced pick, entree paper selon settings."
              : "Paper trading sur marches reels Polymarket. Les positions sont fictives et restent invisibles sur la Home."}
          </p>
        </div>
        <div className="simulation-actions">
          <button className="primary" onClick={() => setShowAddBot(true)} type="button">
            Ajouter un bot
          </button>
          <button
            disabled={activeBot === null}
            onClick={() => {
              if (activeBot?.status === "running") {
                pauseActiveBot();
              } else {
                resumeActiveBot();
              }
            }}
            type="button"
          >
            {activeBot?.status === "running" ? "Pause simulation" : "Reprendre"}
          </button>
        </div>
      </div>

      <div className="simulation-toolbar">
        <label>
          Marché
          <select value={activeAsset} onChange={(event) => setActiveAsset(event.target.value as BotAsset)}>
            {BOT_ASSETS.map((asset) => (
              <option key={asset} value={asset}>
                {asset} 5m
              </option>
            ))}
          </select>
        </label>
        <label>
          Bot actif
          <select value={activeBot?.id ?? ""} onChange={(event) => setSelectedBotId(event.target.value)}>
            {bots.length === 0 ? <option value="">Créer un bot</option> : null}
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle-row">
          <input checked={showPositions} onChange={(event) => setShowPositions(event.target.checked)} type="checkbox" />
          Afficher les positions
        </label>
        <span className="read-only-notice">100% paper trading - aucune exécution réelle</span>
      </div>

      {activeBot === null ? (
        <section className="simulation-empty">
          <h2>Aucun bot configuré</h2>
          <p>Crée un bot pour commencer une simulation locale avec capital fictif.</p>
          <button className="primary" onClick={() => setShowAddBot(true)} type="button">
            Ajouter un bot
          </button>
        </section>
      ) : (
        <>
          <div className="simulation-metrics">
            <Metric label="Bot" value={activeBot.name} />
            <Metric label="Capital actuel" value={formatUsd(stats?.currentBalance ?? activeBot.currentBalance)} />
            <Metric label="PnL total" value={formatSignedUsd(stats?.totalPnlUsd ?? 0)} />
            <Metric label="Win rate" value={formatPercentNumber(stats?.winRate ?? 0)} />
            <Metric label="Drawdown" value={formatPercentNumber(stats?.maxDrawdownPercent ?? 0)} />
            <Metric label="Status" value={activeBot.status.toUpperCase()} />
          </div>

          <div className="simulation-layout">
            <div className="simulation-chart-card">
              {simulationChartMarkets.length === 0 ? (
                <div className="simulation-empty compact">
                  <h2>Marché en attente</h2>
                  <p>Le marché crypto 5m sélectionné n’est pas encore disponible dans la réponse Polymarket.</p>
                </div>
              ) : (
                <div className="simulation-chart-grid" aria-label="Multi-graphique Simulation Bot">
                  {Array.from({ length: 6 }, (_, index) => {
                    const market = simulationChartMarkets[index] ?? null;

                    if (market === null) {
                      return (
                        <div className="simulation-empty compact simulation-chart-placeholder" key={`simulation-chart-placeholder-${index}`}>
                          <h2>Slot {index + 1}</h2>
                          <p>MarchÃ© assignÃ© en attente.</p>
                        </div>
                      );
                    }

                    return (
                      <FeaturedMarketCard
                        compact
                        key={getMarketKey(market)}
                        market={market}
                        onRefresh={async () => undefined}
                        prices={prices}
                        showMarketProbability={index === 0}
                        showSimulationOverlays={showPositions}
                        simulationPositions={getVisiblePositionsForMarket(market)}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            <aside className="simulation-side-panel">
              <div className="bot-mini-profile">
                <span className={`bot-status-dot ${activeBot.status}`} />
                <div>
                  <strong>{activeBot.name}</strong>
                  <span>{BOT_PROFILE_LABELS[activeBot.profile]} · {activeBot.modelMode}</span>
                </div>
              </div>
              <div className="detail-grid compact-grid">
                <Metric label="Risque/trade" value={`${activeBot.riskPercentPerTrade}%`} />
                <Metric label="Edge min" value={`${activeBot.minEdgePercent}%`} />
                <Metric label="Open positions" value={String(stats?.openPositionsCount ?? 0)} />
                <Metric label="Dernière décision" value={activeDecision?.decision ?? "NO_TRADE"} />
                <Metric label="Actifs scannés" value={getRuntimeBotAssets(activeBot).join(", ")} />
                <Metric label="Marchés scannés" value={String(assignedBotMarkets.length)} />
              </div>
              <div className="decision-card">
                <h3>Dernière décision</h3>
                {activeDecision === null ? (
                  <p>Aucune décision journalisée pour ce bot.</p>
                ) : (
                  <>
                    <strong>{activeDecision.asset} 5m · {activeDecision.decision}</strong>
                    <p>
                      P YES {formatPercentNumber(activeDecision.modelProbabilityYes * 100)} · Ask YES{" "}
                      {formatPercentNumber(activeDecision.polymarketAskYes * 100)} · Edge net{" "}
                      {formatPercentNumber(activeDecision.edgeNet * 100)}
                    </p>
                    <ul>
                      {[...activeDecision.reasons, ...activeDecision.blockedBy].slice(0, 4).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div className="side-actions">
                <button onClick={() => updateActiveBot({ allowedAssets: [...BOT_ASSETS] })} type="button">Tous les actifs</button>
                <button onClick={duplicateActiveBot} type="button">Dupliquer</button>
                <button onClick={resetActiveBot} type="button">Reset</button>
                <button onClick={deleteActiveBot} type="button">Supprimer</button>
              </div>
            </aside>
          </div>

          <div className="simulation-sections">
            <PerformancePanel stats={stats} />
            <OpeningScenarioBotPanel
              decisions={activeBotDecisions}
              onChange={saveOpeningSettings}
              settings={openingSettings}
              status={openingSettingsStatus}
            />
            <FinalSettlementPanel decisions={activeBotDecisions} />
            <PositionsPanel positions={activeBotPositions} />
            <DecisionsPanel decisions={activeBotDecisions} />
            <SessionExportPanel
              bot={activeBot}
              decisions={activeBotDecisions}
              fills={activeBotFills}
              orders={activeBotOrders}
              positions={activeBotPositions}
              sessions={activeBotSessions}
              stats={stats}
            />
            <AnalysisPanel daily={dailyAnalysis} mtf={mtfAnalysis} />
            <SimulationComparison
              bots={bots}
              decisions={decisions}
              onDeleteBot={deleteBotById}
              positions={positions}
              selectedBotId={activeBot.id}
              setSelectedBotId={setSelectedBotId}
            />
          </div>
        </>
      )}

      {showAddBot ? (
        <AddBotModal
          form={form}
          onCancel={() => setShowAddBot(false)}
          onCreate={createBot}
          setForm={setForm}
        />
      ) : null}
    </section>
  );
}

function PerformancePanel({ stats }: { stats: BotPerformanceStats | null }) {
  return (
    <article className="simulation-panel">
      <h2>Performance</h2>
      <div className="detail-grid compact-grid">
        <Metric label="Capital départ" value={formatUsd(stats?.startingBalance ?? 0)} />
        <Metric label="ROI" value={formatPercentNumber(stats?.totalPnlPercent ?? 0)} />
        <Metric label="Trades" value={String(stats?.tradesCount ?? 0)} />
        <Metric label="Profit factor" value={formatRatio(stats?.profitFactor ?? 0)} />
        <Metric label="Average edge" value={formatPercentNumber(stats?.averageEdgePercent ?? 0)} />
        <Metric label="Fill rate" value={formatPercentNumber(stats?.fillRate ?? 0)} />
        <Metric label="NO_TRADE" value={String(stats?.noTradeCount ?? 0)} />
        <Metric label="Trades bloqués" value={String(stats?.blockedTradeCount ?? 0)} />
      </div>
      <p className="panel-note">Stats fictives du moteur local. Elles ne représentent aucune position réelle.</p>
    </article>
  );
}

function OpeningScenarioBotPanel({
  decisions,
  onChange,
  settings,
  status,
}: {
  decisions: BotDecision[];
  onChange: (patch: Partial<OpeningScenarioSettings>) => void;
  settings: OpeningScenarioSettings;
  status: "idle" | "saving" | "saved" | "error";
}) {
  const rows = decisions.filter((decision) => decision.diagnostics?.openingScenario !== undefined).slice(0, 7);
  const latest = rows[0]?.diagnostics;
  const saveNumber = (key: keyof OpeningScenarioSettings, value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      onChange({ [key]: parsed } as Partial<OpeningScenarioSettings>);
    }
  };

  return (
    <article className="simulation-panel opening-scenario-panel">
      <div className="panel-title-row">
        <div>
          <h2>Opening Scenario Bot</h2>
          <p>Profil v3-opening-scenario-final-settlement. Analyse 3 scenarios a l'ouverture, paper trading uniquement.</p>
        </div>
        <span className={`status-pill ${settings.enabled ? "live" : "offline"}`}>{settings.enabled ? "ON" : "OFF"}</span>
      </div>

      <div className="opening-settings-grid">
        <label className="toggle-row">
          <input checked={settings.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} type="checkbox" />
          Enabled
        </label>
        <label className="toggle-row">
          <input checked={settings.openAtMarketStart} onChange={(event) => onChange({ openAtMarketStart: event.target.checked })} type="checkbox" />
          Open at start
        </label>
        <label className="toggle-row">
          <input checked={settings.nearTargetAtOpenIsAllowed} onChange={(event) => onChange({ nearTargetAtOpenIsAllowed: event.target.checked })} type="checkbox" />
          Near target allowed
        </label>
        <label className="toggle-row">
          <input checked={settings.usePreOpenBiasWhenNearTarget} onChange={(event) => onChange({ usePreOpenBiasWhenNearTarget: event.target.checked })} type="checkbox" />
          Pre-open bias
        </label>
        <label className="toggle-row">
          <input checked={settings.doNotForceUnclearBecauseNearTargetAtOpen} onChange={(event) => onChange({ doNotForceUnclearBecauseNearTargetAtOpen: event.target.checked })} type="checkbox" />
          No near-target unclear
        </label>
        <label>
          Entry mode
          <select value={settings.entryMode} onChange={(event) => onChange({ entryMode: event.target.value as OpeningEntryMode })}>
            {(["OFF", "IF_APPROVED", "FORCED_PAPER_ONLY", "FORCED_MIN_STAKE_PAPER"] as OpeningEntryMode[]).map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
        </label>
        <label>
          Min confidence
          <input max="0.80" min="0.50" onChange={(event) => saveNumber("minConfidenceForOpeningEntry", event.target.value)} step="0.01" type="number" value={settings.minConfidenceForOpeningEntry} />
        </label>
        <label>
          Min edge net
          <input max="0.20" min="0" onChange={(event) => saveNumber("minEdgeNetForOpeningEntry", event.target.value)} step="0.01" type="number" value={settings.minEdgeNetForOpeningEntry} />
        </label>
        <label>
          Max spread %
          <input max="10" min="1" onChange={(event) => saveNumber("maxSpreadPercent", event.target.value)} step="0.5" type="number" value={settings.maxSpreadPercent} />
        </label>
        <label>
          Min liquidity
          <input max="100" min="0" onChange={(event) => saveNumber("minLiquidityScore", event.target.value)} step="1" type="number" value={settings.minLiquidityScore} />
        </label>
        <label>
          Delay ms
          <input max="5000" min="0" onChange={(event) => saveNumber("entryDelayMs", event.target.value)} step="50" type="number" value={settings.entryDelayMs} />
        </label>
        <label>
          Window sec
          <input max="30" min="1" onChange={(event) => saveNumber("entryWindowSeconds", event.target.value)} step="1" type="number" value={settings.entryWindowSeconds} />
        </label>
        <label>
          Min stake
          <input min="0" onChange={(event) => saveNumber("minStakeUsd", event.target.value)} step="0.5" type="number" value={settings.minStakeUsd} />
        </label>
        <label>
          Max stake
          <input min={settings.minStakeUsd} onChange={(event) => saveNumber("maxOpeningStakeUsd", event.target.value)} step="0.5" type="number" value={settings.maxOpeningStakeUsd} />
        </label>
        <label className="toggle-row">
          <input checked={settings.smartScalingAfterOpening} onChange={(event) => onChange({ smartScalingAfterOpening: event.target.checked })} type="checkbox" />
          Smart scaling
        </label>
      </div>

      <div className="asset-pill-row">
        {BOT_ASSETS.map((asset) => {
          const selected = settings.allowedAssets.includes(asset);
          return (
            <button
              className={selected ? "active" : ""}
              key={asset}
              onClick={() =>
                onChange({
                  allowedAssets: selected ? settings.allowedAssets.filter((item) => item !== asset) : [...settings.allowedAssets, asset],
                })
              }
              type="button"
            >
              {asset}
            </button>
          );
        })}
        <span>{status === "saving" ? "Saving..." : status === "saved" ? "Saved" : status === "error" ? "Settings API error" : ""}</span>
      </div>

      <div className="detail-grid compact-grid">
        <Metric label="Marches analyses" value={String(rows.length)} />
        <Metric label="Forced picks" value={String(rows.filter((decision) => decision.diagnostics?.openingScenario?.forcedPaperPick !== undefined).length)} />
        <Metric label="Starter approved" value={String(rows.filter((decision) => decision.diagnostics?.openingEntry?.action === "OPEN_STARTER_POSITION").length)} />
        <Metric label="Derniere action" value={latest?.openingEntry?.action ?? "NO_TRADE"} />
      </div>

      <div className="simulation-table-wrap">
        <table className="simulation-table compact-v3-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Target</th>
              <th>Open</th>
              <th>Current</th>
              <th>A</th>
              <th>B</th>
              <th>C</th>
              <th>Primary</th>
              <th>Forced pick</th>
              <th>Opening decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((decision) => {
              const scenario = decision.diagnostics?.openingScenario;
              const a = scenario?.scenarios.find((item) => item.scenarioId === "A");
              const b = scenario?.scenarios.find((item) => item.scenarioId === "B");
              const c = scenario?.scenarios.find((item) => item.scenarioId === "C");
              return (
                <tr key={decision.id} title={[scenario?.explanation, decision.diagnostics?.openingEntry?.explanation].filter(Boolean).join(" | ")}>
                  <td>{decision.asset}</td>
                  <td>{formatUsd(scenario?.targetPrice ?? null)}</td>
                  <td>{formatUsd(scenario?.openingCryptoPrice ?? null)}</td>
                  <td>{formatUsd(scenario?.currentPrice ?? null)}</td>
                  <td>{formatOpeningScenarioCell(a)}</td>
                  <td>{formatOpeningScenarioCell(b)}</td>
                  <td>{formatOpeningScenarioCell(c)}</td>
                  <td>{scenario?.primaryScenario.label ?? "UNCLEAR_CHOP"}</td>
                  <td>{scenario === undefined ? "" : `${scenario.forcedPaperPick.side} ${formatPercentNumber(scenario.forcedPaperPick.confidence * 100)}`}</td>
                  <td>{decision.diagnostics?.openingEntry?.action ?? scenario?.openingDecision ?? "NO_TRADE"}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10}>Aucune decision Opening Scenario encore journalisee.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function formatOpeningScenarioCell(scenario: OpeningScenarioResult["scenarios"][number] | undefined) {
  if (scenario === undefined) return "";
  return `${scenario.side} ${formatPercentNumber(scenario.probability * 100)} ${scenario.entryPlan}`;
}

function FinalSettlementPanel({ decisions }: { decisions: BotDecision[] }) {
  const rows = decisions
    .filter((decision) => decision.diagnostics?.finalSettlement !== undefined)
    .slice(0, 8);

  return (
    <article className="simulation-panel final-settlement-panel">
      <div className="panel-title-row">
        <div>
          <h2>Final Settlement Dashboard</h2>
          <p>V3 predit le prix final a expiration. Les picks forces mesurent la qualite predictive sans ouvrir de position.</p>
        </div>
      </div>
      <div className="simulation-table-wrap">
        <table className="simulation-table compact-v3-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Target</th>
              <th>Prix</th>
              <th>Position</th>
              <th>Temps</th>
              <th>Forecast</th>
              <th>Above</th>
              <th>Below</th>
              <th>YES ask</th>
              <th>NO ask</th>
              <th>Edge YES</th>
              <th>Edge NO</th>
              <th>Decision</th>
              <th>Forced pick</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((decision) => {
              const forecast = decision.diagnostics?.finalSettlement;
              const opportunity = decision.diagnostics?.entryOpportunity;
              const forcedPick = decision.diagnostics?.forcedPaperPick;
              const mandatory = decision.diagnostics?.mandatoryDecision;
              return (
                <tr key={decision.id} title={[forecast?.explanation, opportunity?.explanation, mandatory?.explanation].filter(Boolean).join(" | ")}>
                  <td>{decision.asset}</td>
                  <td>{formatUsd(decision.diagnostics?.targetPrice ?? null)}</td>
                  <td>{formatUsd(decision.diagnostics?.cryptoPrice ?? null)}</td>
                  <td>{forecast?.currentPositionRelativeToTarget ?? "NEAR"}</td>
                  <td>{decision.diagnostics?.timeToExpirySeconds ?? 0}s</td>
                  <td>{forecast?.forecast ?? "UNCLEAR"}</td>
                  <td>{formatPercentNumber((forecast?.probabilityFinalAbove ?? 0.5) * 100)}</td>
                  <td>{formatPercentNumber((forecast?.probabilityFinalBelow ?? 0.5) * 100)}</td>
                  <td>{formatCents(decision.polymarketAskYes)}</td>
                  <td>{formatCents(decision.polymarketAskNo)}</td>
                  <td className={(opportunity?.edgeYesNet ?? decision.edgeYes) >= 0 ? "positive-text" : "negative-text"}>
                    {formatPercentNumber((opportunity?.edgeYesNet ?? decision.edgeYes) * 100)}
                  </td>
                  <td className={(opportunity?.edgeNoNet ?? decision.edgeNo) >= 0 ? "positive-text" : "negative-text"}>
                    {formatPercentNumber((opportunity?.edgeNoNet ?? decision.edgeNo) * 100)}
                  </td>
                  <td>{mandatory?.status ?? decision.decision}</td>
                  <td>{forcedPick === undefined ? "" : `${forcedPick.side} ${formatPercentNumber(forcedPick.confidence * 100)}`}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={14}>Aucune decision V3 encore journalisee.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function PositionsPanel({ positions }: { positions: SimulatedPosition[] }) {
  return (
    <article className="simulation-panel">
      <h2>Positions simulées</h2>
      <div className="simulation-table-wrap">
        <table className="simulation-table">
          <thead>
            <tr>
              <th>Heure</th>
              <th>Marché</th>
              <th>Side</th>
              <th>Entry</th>
              <th>Size</th>
              <th>PnL</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.slice(0, 12).map((position) => (
              <tr key={position.id}>
                <td>{formatPreciseTime(position.entryTimestamp)}</td>
                <td>{position.asset} 5m</td>
                <td>{position.side}</td>
                <td>{formatCents(position.entryTokenPrice)}</td>
                <td>{formatUsd(position.entrySizeUsd)}</td>
                <td className={(position.pnlUsd ?? 0) >= 0 ? "positive-text" : "negative-text"}>
                  {position.pnlUsd === undefined ? "Open" : formatSignedUsd(position.pnlUsd)}
                </td>
                <td>{position.status}</td>
              </tr>
            ))}
            {positions.length === 0 ? (
              <tr>
                <td colSpan={7}>Aucune position paper pour le bot actif.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function DecisionsPanel({ decisions }: { decisions: BotDecision[] }) {
  return (
    <article className="simulation-panel">
      <h2>Décisions récentes</h2>
      <div className="decision-list">
        {decisions.slice(0, 10).map((decision) => (
          <div className="decision-row" key={decision.id}>
            <span>{formatPreciseTime(decision.timestamp)}</span>
            <strong>{decision.asset} · {decision.decision}</strong>
            <span>Edge {formatPercentNumber(decision.edgeNet * 100)}</span>
            <span>Confidence {formatPercentNumber(decision.confidence * 100)}</span>
            <p>{[...decision.reasons, ...decision.blockedBy].slice(0, 3).join(" · ")}</p>
          </div>
        ))}
        {decisions.length === 0 ? <p>Aucune décision enregistrée.</p> : null}
      </div>
    </article>
  );
}

function SessionExportPanel({
  bot,
  decisions,
  fills,
  orders,
  positions,
  sessions,
  stats,
}: {
  bot: BotConfig;
  decisions: BotDecision[];
  fills: PaperFill[];
  orders: PaperOrder[];
  positions: SimulatedPosition[];
  sessions: SimulationSession[];
  stats: BotPerformanceStats | null;
}) {
  const exportPayload = buildSimulationExportPayload({ bot, decisions, fills, orders, positions, sessions, stats });
  const sessionRows = sessions.slice(0, 8).map((session) => ({
    ...session,
    decisionsCount: decisions.filter((decision) => decision.sessionId === session.id).length,
    fillsCount: fills.filter((fill) => fill.sessionId === session.id).length,
    ordersCount: orders.filter((order) => order.sessionId === session.id).length,
    positionsCount: positions.filter((position) => position.sessionId === session.id).length,
  }));

  return (
    <article className="simulation-panel export-panel">
      <div className="panel-title-row">
        <div>
          <h2>Export & sessions</h2>
          <p>Historique complet des sessions paper, ordres fictifs, fills, positions et décisions.</p>
        </div>
        <div className="export-actions">
          <button onClick={() => downloadJson(`black-goat-${bot.name}-analysis.json`, exportPayload)} type="button">
            Export JSON
          </button>
          <button onClick={() => downloadCsv(`black-goat-${bot.name}-positions.csv`, positionsToCsv(positions, decisions, orders, fills))} type="button">
            Export CSV
          </button>
          <button onClick={() => downloadCsv(`black-goat-${bot.name}-decisions.csv`, decisionsToCsv(decisions))} type="button">
            Export decisions
          </button>
          <button onClick={() => void copyExportToClipboard(exportPayload)} type="button">
            Copier JSON
          </button>
        </div>
      </div>

      <div className="export-summary">
        <Metric label="Sessions" value={String(sessions.length)} />
        <Metric label="Paper orders" value={String(orders.length)} />
        <Metric label="Paper fills" value={String(fills.length)} />
        <Metric label="Décisions" value={String(decisions.length)} />
      </div>

      <div className="simulation-table-wrap">
        <table className="simulation-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Début</th>
              <th>Fin</th>
              <th>Status</th>
              <th>Assets</th>
              <th>Orders</th>
              <th>Fills</th>
              <th>Positions</th>
              <th>Décisions</th>
            </tr>
          </thead>
          <tbody>
            {sessionRows.map((session) => (
              <tr key={session.id}>
                <td title={session.id}>{shortId(session.id)}</td>
                <td>{formatDateTime(session.startedAt)}</td>
                <td>{session.endedAt === undefined ? "Running" : formatDateTime(session.endedAt)}</td>
                <td>{session.status}</td>
                <td>{session.assets.join(", ")}</td>
                <td>{session.ordersCount}</td>
                <td>{session.fillsCount}</td>
                <td>{session.positionsCount}</td>
                <td>{session.decisionsCount}</td>
              </tr>
            ))}
            {sessionRows.length === 0 ? (
              <tr>
                <td colSpan={9}>Aucune session enregistrée. Clique sur Reprendre pour démarrer une session.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="panel-note">
        Les exports sont générés localement depuis le navigateur. Ils ne contiennent aucun ordre réel et ne sont envoyés à aucun serveur tiers.
      </p>
    </article>
  );
}

function AnalysisPanel({ daily, mtf }: { daily: DailyAnalysis; mtf: MultiTimeframeAnalysis }) {
  return (
    <article className="simulation-panel analysis-panel">
      <h2>Analyse du bot</h2>
      <div className="analysis-grid">
        <div>
          <h3>Daily Bias</h3>
          <strong>{daily.asset} · {daily.dailyBias}</strong>
          <span>Confidence {formatPercentNumber(daily.confidence * 100)}</span>
          <span>Risk mode {daily.volatilityRegime}</span>
          <span>Directions {daily.allowedDirection.join(" / ")}</span>
          <p>{daily.avoidConditions.join(" · ")}</p>
        </div>
        <div>
          <h3>Multi-timeframe</h3>
          <strong>Alignment {mtf.alignmentScore}/100</strong>
          <span>Daily {mtf.trendDaily}</span>
          <span>4h {mtf.trend4h} · 1h {mtf.trend1h}</span>
          <span>15m {mtf.trend15m} · 5m {mtf.trend5m} · 1m {mtf.trend1m}</span>
          <p>{mtf.conclusion}</p>
        </div>
      </div>
    </article>
  );
}

function SimulationComparison({
  bots,
  decisions,
  onDeleteBot,
  positions,
  selectedBotId,
  setSelectedBotId,
}: {
  bots: BotConfig[];
  decisions: BotDecision[];
  onDeleteBot: (botId: string) => void;
  positions: SimulatedPosition[];
  selectedBotId: string;
  setSelectedBotId: (botId: string) => void;
}) {
  return (
    <article className="simulation-panel comparison-panel">
      <h2>Comparaison des simulations</h2>
      <div className="simulation-table-wrap">
        <table className="simulation-table">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Profil</th>
              <th>Capital</th>
              <th>PnL</th>
              <th>ROI</th>
              <th>Win rate</th>
              <th>Drawdown</th>
              <th>Trades</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => {
              const stats = calculatePerformanceStats(
                bot,
                positions.filter((position) => position.botId === bot.id),
                decisions.filter((decision) => decision.botId === bot.id),
              );
              return (
                <tr className={bot.id === selectedBotId ? "selected" : ""} key={bot.id} onClick={() => setSelectedBotId(bot.id)}>
                  <td>{bot.name}</td>
                  <td>{BOT_PROFILE_LABELS[bot.profile]}</td>
                  <td>{formatUsd(stats.currentBalance)}</td>
                  <td className={stats.totalPnlUsd >= 0 ? "positive-text" : "negative-text"}>{formatSignedUsd(stats.totalPnlUsd)}</td>
                  <td>{formatPercentNumber(stats.totalPnlPercent)}</td>
                  <td>{formatPercentNumber(stats.winRate)}</td>
                  <td>{formatPercentNumber(stats.maxDrawdownPercent)}</td>
                  <td>{stats.tradesCount}</td>
                  <td>{bot.status}</td>
                  <td>
                    <button
                      className="table-action-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteBot(bot.id);
                      }}
                      type="button"
                    >
                      Supprimer
                    </button>
                  </td>
                </tr>
              );
            })}
            {bots.length === 0 ? (
              <tr>
                <td colSpan={10}>Aucune simulation à comparer.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function AddBotModal({
  form,
  onCancel,
  onCreate,
  setForm,
}: {
  form: BotFormState;
  onCancel: () => void;
  onCreate: () => void;
  setForm: (updater: BotFormState | ((current: BotFormState) => BotFormState)) => void;
}) {
  const updateField = (field: keyof BotFormState, value: BotFormState[keyof BotFormState]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const applyProfile = (profile: BotRiskProfile) => {
    setForm((current) => ({
      ...createBotFormState(profile),
      allowedAssets: current.allowedAssets,
      name: current.name,
      startingBalance: current.startingBalance,
    }));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="Ajouter un bot" className="bot-modal">
        <div className="modal-head">
          <div>
            <h2>Ajouter un bot</h2>
            <p>Paramètres de simulation uniquement, pas un conseil financier.</p>
          </div>
          <button onClick={onCancel} type="button">×</button>
        </div>
        <div className="bot-form-grid">
          <label>
            Nom du bot
            <input value={form.name} onChange={(event) => updateField("name", event.target.value)} />
          </label>
          <label>
            Montant de départ
            <input min="1" type="number" value={form.startingBalance} onChange={(event) => updateField("startingBalance", event.target.value)} />
          </label>
          <label>
            Profil
            <select value={form.profile} onChange={(event) => applyProfile(event.target.value as BotRiskProfile)}>
              {(Object.keys(BOT_PROFILE_LABELS) as BotRiskProfile[]).map((profile) => (
                <option key={profile} value={profile}>
                  {BOT_PROFILE_LABELS[profile]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Risque par trade %
            <input type="number" value={form.riskPercentPerTrade} onChange={(event) => updateField("riskPercentPerTrade", event.target.value)} />
          </label>
          <label>
            Risque journalier max %
            <input type="number" value={form.maxDailyRiskPercent} onChange={(event) => updateField("maxDailyRiskPercent", event.target.value)} />
          </label>
          <label>
            Trades max/jour
            <input type="number" value={form.maxTradesPerDay} onChange={(event) => updateField("maxTradesPerDay", event.target.value)} />
          </label>
          <label>
            Positions ouvertes max
            <input type="number" value={form.maxOpenPositions} onChange={(event) => updateField("maxOpenPositions", event.target.value)} />
          </label>
          <label>
            Edge minimum %
            <input type="number" value={form.minEdgePercent} onChange={(event) => updateField("minEdgePercent", event.target.value)} />
          </label>
          <label>
            Spread maximum %
            <input type="number" value={form.maxSpreadPercent} onChange={(event) => updateField("maxSpreadPercent", event.target.value)} />
          </label>
          <label>
            Score liquidité minimum
            <input type="number" value={form.minLiquidityScore} onChange={(event) => updateField("minLiquidityScore", event.target.value)} />
          </label>
          <label>
            Temps min avant expiration
            <input type="number" value={form.minTimeToExpirySeconds} onChange={(event) => updateField("minTimeToExpirySeconds", event.target.value)} />
          </label>
          <label>
            Temps max avant expiration
            <input type="number" value={form.maxTimeToExpirySeconds} onChange={(event) => updateField("maxTimeToExpirySeconds", event.target.value)} />
          </label>
          <label>
            Mode de modèle
            <select value={form.modelMode} onChange={(event) => updateField("modelMode", event.target.value as BotConfig["modelMode"])}>
              <option value="rules">Rules</option>
              <option value="probabilistic">Probabilistic</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </label>
          <label>
            Fill paper
            <select value={form.fillModel} onChange={(event) => updateField("fillModel", event.target.value as BotConfig["fillModel"])}>
              <option value="optimistic">Optimistic</option>
              <option value="realistic">Realistic</option>
              <option value="conservative">Conservative</option>
            </select>
          </label>
          <fieldset>
            <legend>Actifs autorisés</legend>
            {BOT_ASSETS.map((asset) => (
              <label className="checkbox-line" key={asset}>
                <input
                  checked={form.allowedAssets.includes(asset)}
                  onChange={(event) =>
                    updateField(
                      "allowedAssets",
                      event.target.checked
                        ? Array.from(new Set([...form.allowedAssets, asset]))
                        : form.allowedAssets.filter((item) => item !== asset),
                    )
                  }
                  type="checkbox"
                />
                {asset}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel} type="button">Annuler</button>
          <button className="primary" onClick={onCreate} type="button">Créer le bot</button>
        </div>
      </section>
    </div>
  );
}

function useSimulationSnapshots(markets: PublicMarket[]): Record<string, SimulationSnapshot> {
  const [snapshots, setSnapshots] = useState<Record<string, SimulationSnapshot>>({});
  const marketSignature = useMemo(() => markets.map(getMarketKey).join("|"), [markets]);

  useEffect(() => {
    if (markets.length === 0) {
      setSnapshots({});
      return;
    }

    let stopped = false;
    const load = async () => {
      const loaded = await Promise.all(
        markets.map(async (market) => {
          try {
            return await loadSimulationSnapshotForMarket(market);
          } catch {
            return [getMarketKey(market), null] as const;
          }
        }),
      );

      if (stopped) {
        return;
      }

      setSnapshots((current) => {
        const next: Record<string, SimulationSnapshot> = {};
        for (const market of markets) {
          const key = getMarketKey(market);
          const loadedSnapshot = loaded.find(([loadedKey]) => loadedKey === key)?.[1] ?? null;
          next[key] = loadedSnapshot ?? current[key] ?? EMPTY_SIMULATION_SNAPSHOT;
        }
        return next;
      });
    };

    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [marketSignature, markets]);

  return snapshots;
}

function useSimulationSnapshot(market: PublicMarket | null): SimulationSnapshot {
  const markets = useMemo(() => (market === null ? [] : [market]), [market]);
  const snapshots = useSimulationSnapshots(markets);
  return market === null ? EMPTY_SIMULATION_SNAPSHOT : snapshots[getMarketKey(market)] ?? EMPTY_SIMULATION_SNAPSHOT;
}

async function loadSimulationSnapshotForMarket(market: PublicMarket): Promise<readonly [string, SimulationSnapshot]> {
  const key = getMarketKey(market);
  const symbols = getCryptoSymbolsForMarket(market);
  const { endMs, startMs } = getMarketTimeBounds(market);
  const startTs = startMs === null ? Math.floor((Date.now() - 5 * 60_000) / 1_000) : Math.floor(startMs / 1_000);
  const endTs = endMs === null ? Math.floor(Date.now() / 1_000) : Math.floor(endMs / 1_000);
  const query = new URLSearchParams({
    endTs: String(endTs),
    limit: "600",
    startTs: String(startTs),
    symbol: symbols.chainlinkSymbol,
  });
  const response = await fetch(`/api/polymarket/crypto-prices/history?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as CryptoPriceHistoryResponse;
  const points = payload.points
    .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
    .map((point) => ({
      price: point.price,
      time: formatChartTime(Math.floor(point.timestamp / 1_000)),
      timestamp: Math.floor(point.timestamp / 1_000) * 1_000,
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = points[points.length - 1] ?? null;
  const targetFromMarket = resolvePolymarketTarget(market);
  const firstAfterStart =
    startMs === null
      ? null
      : points.find((point) => point.timestamp >= startMs && point.timestamp - startMs <= 120_000);

  return [
    key,
    {
      currentPrice: latest?.price ?? null,
      points,
      targetPrice: targetFromMarket ?? firstAfterStart?.price ?? null,
    },
  ] as const;
}

function applyCryptoUpdateToSimulationSnapshot(
  snapshot: SimulationSnapshot,
  market: PublicMarket,
  update: CryptoPriceUpdate,
): SimulationSnapshot {
  const { endMs, startMs } = getMarketTimeBounds(market);
  const parsedUpdateTime = Date.parse(update.time);
  const updateTimestamp = update.upstreamTimestamp ?? (Number.isNaN(parsedUpdateTime) ? Date.now() : parsedUpdateTime);
  if (startMs !== null && updateTimestamp < startMs) {
    return snapshot;
  }

  const maxAcceptedTimestamp = endMs === null ? Number.POSITIVE_INFINITY : endMs + 30_000;
  if (updateTimestamp > maxAcceptedTimestamp) {
    return snapshot;
  }

  const metadataTarget = resolvePolymarketTarget(market);
  const openingTickTarget =
    snapshot.targetPrice ??
    (startMs !== null && update.source === "chainlink" && updateTimestamp >= startMs && updateTimestamp - startMs <= 30_000
      ? update.price
      : null);

  return {
    currentPrice: update.price,
    points: appendCryptoPoint(snapshot.points, update, startMs, endMs),
    targetPrice: metadataTarget ?? openingTickTarget,
  };
}

function groupMarketsByCryptoSymbol(markets: PublicMarket[]) {
  const groups = new Map<
    string,
    {
      markets: PublicMarket[];
      symbols: ReturnType<typeof getCryptoSymbolsForMarket>;
    }
  >();

  for (const market of markets) {
    const symbols = getCryptoSymbolsForMarket(market);
    const key = `${symbols.chainlinkSymbol}|${symbols.fallbackSymbol}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { markets: [market], symbols });
    } else {
      existing.markets.push(market);
    }
  }

  return Array.from(groups.values());
}

function getMarketTimeBounds(market: PublicMarket) {
  const parsedStartMs = market.eventStartTime === null ? NaN : Date.parse(market.eventStartTime);
  const parsedEndMs = market.endDate === null ? NaN : Date.parse(market.endDate);

  return {
    endMs: Number.isNaN(parsedEndMs) ? null : parsedEndMs,
    startMs: Number.isNaN(parsedStartMs) ? null : parsedStartMs,
  };
}

function runPaperTradingTick({
  bot,
  dailyAnalysis,
  decisions,
  market,
  mtfAnalysis,
  nowMs,
  openingScenarioSettings,
  positions,
  prices,
  session,
  snapshot,
}: {
  bot: BotConfig;
  dailyAnalysis: DailyAnalysis;
  decisions: BotDecision[];
  market: PublicMarket;
  mtfAnalysis: MultiTimeframeAnalysis;
  nowMs: number;
  openingScenarioSettings: OpeningScenarioSettings;
  positions: SimulatedPosition[];
  prices: Record<string, LivePrice>;
  session: SimulationSession | null;
  snapshot: SimulationSnapshot;
}) {
  const asset = getBotAssetForMarket(market) ?? "BTC";
  const marketId = getMarketKey(market);
  let sessionForTick = session ?? createSimulationSession(bot, market);
  sessionForTick = touchSimulationSession(sessionForTick, market, asset, bot.currentBalance);
  let nextPositions = resolvePaperPositions({
    botId: bot.id,
    currentPrice: snapshot.currentPrice,
    market,
    positions,
    targetPrice: snapshot.targetPrice,
    nowMs,
  });
  const resolvedChanged = nextPositions !== positions;
  const statsAfterResolution = calculatePerformanceStats(
    bot,
    nextPositions.filter((position) => position.botId === bot.id),
    decisions.filter((decision) => decision.botId === bot.id),
  );
  let updatedBot = statsAfterResolution.currentBalance === bot.currentBalance ? bot : { ...bot, currentBalance: statsAfterResolution.currentBalance };
  const rules = getBotRules(updatedBot);
  const shouldPauseAfterTick = statsAfterResolution.consecutiveLosses >= rules.risk.maxConsecutiveLossesBeforePause;

  const lastDecision = decisions.find((decision) => decision.botId === bot.id && decision.marketId === marketId);
  const isOpeningScenarioBot = updatedBot.profile === "opening_scenario_bot";
  const hasOpenPositionOnMarket = nextPositions.some((position) => position.botId === updatedBot.id && position.marketId === marketId && position.status === "open");
  const shouldRetryOpeningDecision =
    isOpeningScenarioBot &&
    openingScenarioSettings.entryMode === "FORCED_MIN_STAKE_PAPER" &&
    !hasOpenPositionOnMarket &&
    lastDecision !== undefined &&
    isRetryableOpeningDecision(lastDecision) &&
    !isCriticalOpeningDataMissing(snapshot, market);
  if (lastDecision !== undefined && ((isOpeningScenarioBot && !shouldRetryOpeningDecision) || (!isOpeningScenarioBot && nowMs - lastDecision.timestamp < 8_000))) {
    return {
      decision: null,
      fill: null,
      order: null,
      positions: nextPositions,
      session: sessionForTick,
      updatedBot,
    };
  }

  const context = buildDecisionContext({
    bot: updatedBot,
    dailyAnalysis,
    market,
    mtfAnalysis,
    nowMs,
    positions: nextPositions,
    prices,
    snapshot,
  });
  const finalSettlement = buildV3ForecastForContext(context);
  const estimate: ProbabilityEstimate = {
    confidence: finalSettlement.confidence,
    pNo: finalSettlement.probabilityFinalBelow,
    pYes: finalSettlement.probabilityFinalAbove,
    reasons: [finalSettlement.explanation, ...finalSettlement.reasonCodes],
    uncertainty: clampProbability(1 - finalSettlement.confidence),
  };
  const entryOpportunity = evaluateEntryOpportunity({
    forecast: finalSettlement,
    liquidityScore: context.liquidityScore,
    noAsk: context.askNo,
    noBid: context.noBid ?? undefined,
    spreadPercent: context.spreadPercent,
    timeRemainingSeconds: context.timeToExpirySeconds,
    yesAsk: context.askYes,
    yesBid: context.yesBid ?? undefined,
  });
  const forcedPaperPick = createForcedPaperPick({
    forecast: finalSettlement,
    opportunity: entryOpportunity,
  });
  const openingScenario = buildOpeningScenarioResultForContext({
    context,
    finalSettlement,
    opportunity: entryOpportunity,
  });
  const minRequiredEdgeYes = getMinimumEdgePercentForTrade(updatedBot, asset, "YES");
  const minRequiredEdgeNo = getMinimumEdgePercentForTrade(updatedBot, asset, "NO");
  const targetComparator = calculateTargetComparator(context, { edgeNo: entryOpportunity.edgeNoNet, edgeYes: entryOpportunity.edgeYesNet }, {
    minRequiredEdgeNo,
    minRequiredEdgeYes,
  });
  const side = entryOpportunity.bestSide === "YES" || entryOpportunity.bestSide === "NO" ? entryOpportunity.bestSide : forcedPaperPick.side;
  const edgeNet = side === "YES" ? entryOpportunity.edgeYesNet : entryOpportunity.edgeNoNet;
  const minRequiredEdgePercent = BLACK_GOAT_V3_CONFIG.entryOpportunityEngine.minEdgeNetForStarter * 100;
  const effectiveRiskPercent = updatedBot.currentBalance <= 0 ? 0 : (rules.risk.minOrderSizeUsd / updatedBot.currentBalance) * 100;
  const positionManagement = evaluatePositionManagementForContext({
    context,
    forecast: finalSettlement,
    opportunity: entryOpportunity,
    positions: nextPositions,
  });
  const diagnostics = buildDecisionDiagnostics({
    context,
    deRisk: positionManagement.deRisk,
    effectiveRiskPercent,
    entryOpportunity,
    estimate,
    finalSettlement,
    forcedPaperPick,
    marketState: context.marketState,
    minRequiredEdgePercent,
    openingScenario,
    openingSettings: openingScenarioSettings,
    side,
    smartScaling: positionManagement.smartScaling,
    targetComparator,
  });
  const risk = validateBotTradeV2(updatedBot, {
    agreementCount: diagnostics.agreementCount,
    asset,
    botPositions: nextPositions.filter((position) => position.botId === updatedBot.id),
    confidence: estimate.confidence,
    contradictionScore: diagnostics.contradictionScore,
    cryptoPriceAgeMs: context.cryptoPriceAgeMs,
    dailyAnalysis,
    decisions: decisions.filter((decision) => decision.botId === updatedBot.id),
    diagnostics,
    edgeNet,
    marketState: context.marketState,
    marketId,
    marketPhase: context.marketPhase,
    mtfAnalysis,
    nowMs,
    polymarketBookAgeMs: context.polymarketBookAgeMs,
    spreadPercent: context.spreadPercent,
    liquidityScore: context.liquidityScore,
    side,
    signalScore: diagnostics.signalScore,
    stats: statsAfterResolution,
    targetPrice: snapshot.targetPrice,
    targetComparator,
    timeToExpirySeconds: context.timeToExpirySeconds,
    todayDecisionCount: decisions.filter((decision) => decision.botId === updatedBot.id && isSameUtcDay(decision.timestamp, nowMs)).length,
    tradesToday: nextPositions.filter((position) => position.botId === updatedBot.id && isSameUtcDay(position.entryTimestamp, nowMs)).length,
  });
  const runtimeAssets = getRuntimeBotAssets(updatedBot);
  const riskDecision = runtimeAssets.includes(asset)
    ? risk
    : { adjustedPositionSize: 0, approved: false, blockedBy: [...risk.blockedBy, "asset non autorise"] };
  const mandatoryDecision = decideMandatoryMarket({
    forecast: finalSettlement,
    forcedPaperPick,
    market: buildCrypto5mMarketFromContext(context),
    opportunity: entryOpportunity,
    riskDecision,
  });
  diagnostics.mandatoryDecision = mandatoryDecision;
  const openingEntry =
    isOpeningScenarioBot && openingScenario !== undefined
      ? decideOpeningEntry({
          market: buildCrypto5mMarketFromContext(context),
          opportunity: entryOpportunity,
          riskDecision,
          scenarioResult: openingScenario,
          settings: openingScenarioSettings,
        })
      : undefined;
  diagnostics.openingEntry = openingEntry;
  diagnostics.forcedMinStakePaperUsed = openingEntry?.forcedMinStakePaperUsed ?? false;
  diagnostics.lateForcedEntryUsed = openingEntry?.lateForcedEntryUsed ?? false;
  const executionSide =
    openingEntry?.action === "OPEN_STARTER_POSITION" && (openingEntry.side === "YES" || openingEntry.side === "NO")
      ? openingEntry.side
      : side;
  const approved = isOpeningScenarioBot
    ? openingEntry?.action === "OPEN_STARTER_POSITION" && runtimeAssets.includes(asset)
    : mandatoryDecision.status === "STARTER_ENTRY_APPROVED" && mandatoryDecision.side === side && runtimeAssets.includes(asset);
  const blockedBy = Array.from(
    new Set(
      approved
        ? []
        : [
            ...riskDecision.blockedBy,
            ...entryOpportunity.reasonCodes,
            ...mandatoryDecision.reasonCodes,
            ...(openingEntry?.reasonCodes ?? []),
            mandatoryDecision.status,
            openingEntry?.action ?? "",
          ],
    ),
  ).filter((reason) => reason.length > 0);
  if (!runtimeAssets.includes(asset)) {
    blockedBy.push("asset non autorise");
  }

  const positionSize = approved ? (openingEntry?.sizeUsd ?? mandatoryDecision.starterSizeUsd) : 0;
  const decisionId = makeId("decision");
  const decision: BotDecision = {
    id: decisionId,
    asset,
    blockedBy,
    botId: updatedBot.id,
    confidence: estimate.confidence,
    decision: approved
      ? executionSide === "YES"
        ? "BUY_YES"
        : "BUY_NO"
      : openingEntry !== undefined
        ? mapOpeningActionToBotDecision(openingEntry.action)
        : mapMandatoryStatusToBotDecision(mandatoryDecision.status),
    edgeNet: executionSide === "YES" ? entryOpportunity.edgeYesNet : entryOpportunity.edgeNoNet,
    edgeNo: entryOpportunity.edgeNoNet,
    edgeYes: entryOpportunity.edgeYesNet,
    marketId,
    modelProbabilityNo: estimate.pNo,
    modelProbabilityYes: estimate.pYes,
    polymarketAskNo: context.askNo,
    polymarketAskYes: context.askYes,
    positionSize,
    diagnostics,
    reasons: [
      finalSettlement.explanation,
      entryOpportunity.explanation,
      mandatoryDecision.explanation,
      forcedPaperPick.reason,
      openingScenario?.explanation ?? "",
      openingEntry?.explanation ?? "",
      ...finalSettlement.reasonCodes,
      ...entryOpportunity.reasonCodes,
    ].filter((reason) => reason.length > 0),
    sessionId: sessionForTick.id,
    timestamp: nowMs,
  };
  let paperOrder: PaperOrder | null = null;
  let paperFill: PaperFill | null = null;

  if (approved && snapshot.currentPrice !== null) {
    const tokenPrice = openingEntry?.entryPrice ?? (executionSide === "YES" ? context.askYes : context.askNo);
    const orderId = makeId("paper-order");
    const fillId = makeId("paper-fill");
    const positionId = makeId("position");
    paperOrder = {
      id: orderId,
      asset,
      botId: updatedBot.id,
      createdAt: nowMs,
      decisionId,
      limitPrice: tokenPrice,
      marketId,
      reasons: estimate.reasons,
      requestedSizeUsd: positionSize,
      sessionId: sessionForTick.id,
      side: executionSide,
      status: "filled",
      type: "paper_order",
    };
    paperFill = {
      id: fillId,
      asset,
      botId: updatedBot.id,
      fillModel: updatedBot.fillModel,
      fillTokenPrice: tokenPrice,
      filledAt: nowMs,
      filledSizeUsd: positionSize,
      marketId,
      notes: ["paper fill local", `slippage model ${updatedBot.fillModel}`],
      orderId,
      positionId,
      sessionId: sessionForTick.id,
      side: executionSide,
      simulatedSlippagePercent: context.slippageEstimate * 100,
      type: "paper_fill",
    };
    const paperPosition: SimulatedPosition = {
      id: positionId,
      asset,
      botId: updatedBot.id,
      decisionReasons: estimate.reasons,
      edgeAtEntry: executionSide === "YES" ? entryOpportunity.edgeYesNet : entryOpportunity.edgeNoNet,
      entryCryptoPrice: snapshot.currentPrice,
      entrySizeUsd: positionSize,
      entryTimestamp: nowMs,
      entryTokenPrice: tokenPrice,
      fillId,
      marketId,
      modelProbabilityAtEntry: executionSide === "YES" ? estimate.pYes : estimate.pNo,
      orderId,
      sessionId: sessionForTick.id,
      side: executionSide,
      status: "open",
    };
    nextPositions = [paperPosition, ...nextPositions].slice(0, SIMULATION_STORAGE_LIMITS.positions);
  }

  return {
    decision,
    fill: paperFill,
    order: paperOrder,
    positions: resolvedChanged || approved ? nextPositions : positions,
    session: sessionForTick,
    updatedBot: shouldPauseAfterTick ? { ...updatedBot, status: "paused" as const } : updatedBot,
  };
}

function buildDecisionContext({
  bot,
  dailyAnalysis,
  market,
  mtfAnalysis,
  nowMs,
  positions,
  prices,
  snapshot,
}: {
  bot: BotConfig;
  dailyAnalysis: DailyAnalysis;
  market: PublicMarket;
  mtfAnalysis: MultiTimeframeAnalysis;
  nowMs: number;
  positions: SimulatedPosition[];
  prices: Record<string, LivePrice>;
  snapshot: SimulationSnapshot;
}) {
  const upIndex = findOutcomeIndex(market.outcomes, "up", 0);
  const downIndex = findOutcomeIndex(market.outcomes, "down", 1);
  const upQuote = getOutcomeQuote(market, prices, upIndex);
  const downQuote = getOutcomeQuote(market, prices, downIndex);
  const askYes = clampProbability(upQuote.bestAsk ?? readNumber(market.outcomePrices[upIndex]) ?? 0.5);
  const askNo = clampProbability(downQuote.bestAsk ?? readNumber(market.outcomePrices[downIndex]) ?? 1 - askYes);
  const yesBid = upQuote.bestBid === null ? null : clampProbability(upQuote.bestBid);
  const noBid = downQuote.bestBid === null ? null : clampProbability(downQuote.bestBid);
  const spreadPercent = Math.max(
    calculateSpreadPercent(upQuote.bestBid, upQuote.bestAsk),
    calculateSpreadPercent(downQuote.bestBid, downQuote.bestAsk),
  );
  const timeToExpirySeconds = market.endDate === null ? 0 : Math.max(0, Math.floor((Date.parse(market.endDate) - nowMs) / 1_000));
  const marketStartMs = market.eventStartTime === null ? null : Date.parse(market.eventStartTime);
  const marketEndMs = market.endDate === null ? null : Date.parse(market.endDate);
  const marketState = getCryptoMarketState({
    finalPrice: market.finalPrice,
    marketEndMs,
    marketStartMs,
    nowMs,
  });
  const velocity = calculatePriceVelocity(snapshot.points);
  const latestPoint = snapshot.points[snapshot.points.length - 1] ?? null;
  const cryptoPriceAgeMs = latestPoint === null ? null : Math.max(0, nowMs - latestPoint.timestamp);
  const polymarketBookAgeMs = getPolymarketBookAgeMs(market, prices, nowMs, upIndex, downIndex);
  const distanceToTargetUsd =
    snapshot.currentPrice !== null && snapshot.targetPrice !== null ? snapshot.currentPrice - snapshot.targetPrice : null;
  const distanceToTarget =
    snapshot.currentPrice !== null && snapshot.targetPrice !== null
      ? (snapshot.currentPrice - snapshot.targetPrice) / Math.max(snapshot.targetPrice, 1)
      : 0;
  const elapsedSinceStartSeconds =
    marketStartMs === null || Number.isNaN(marketStartMs) ? 0 : Math.max(0, Math.floor((nowMs - marketStartMs) / 1_000));
  const marketPhase = resolveMarketPhase(marketState, elapsedSinceStartSeconds, timeToExpirySeconds);
  const volatility1m = estimateWindowVolatility(snapshot.points, nowMs - 60_000);
  const volatility5m = estimateWindowVolatility(snapshot.points, nowMs - 5 * 60_000);

  return {
    askNo,
    askYes,
    asset: getBotAssetForMarket(market) ?? "BTC",
    bot,
    currentPrice: snapshot.currentPrice,
    cryptoPriceAgeMs,
    dailyAnalysis,
    distanceToTarget,
    distanceToTargetUsd,
    distanceToTargetBps: Math.abs(distanceToTarget) * 10_000,
    expiryTime: market.endDate,
    elapsedSinceStartSeconds,
    liquidityScore: calculateLiquidityScore(market.liquidity),
    market,
    marketEndMs,
    marketPhase,
    marketState,
    marketId: getMarketKey(market),
    marketStartMs,
    mtfAnalysis,
    openPositions: positions.filter((position) => position.botId === bot.id && position.status === "open"),
    polymarketBookAgeMs,
    slippageEstimate: bot.fillModel === "optimistic" ? 0.0025 : bot.fillModel === "realistic" ? 0.006 : 0.012,
    spreadPercent,
    startTime: market.eventStartTime,
    targetPrice: snapshot.targetPrice,
    timeToExpirySeconds,
    noBid,
    points: snapshot.points,
    velocity,
    volatility1m,
    volatility5m,
    yesBid,
  };
}

function estimateMarketProbability(context: ReturnType<typeof buildDecisionContext>): ProbabilityEstimate {
  let pYes = 0.5;
  const reasons: string[] = [];

  if (context.distanceToTarget > 0) {
    pYes += Math.min(0.18, context.distanceToTarget * 120);
    reasons.push("prix crypto au-dessus du target");
  } else if (context.distanceToTarget < 0) {
    pYes -= Math.min(0.18, Math.abs(context.distanceToTarget) * 120);
    reasons.push("prix crypto sous le target");
  }

  if (context.velocity > 0) {
    pYes += Math.min(0.08, context.velocity * 80);
    reasons.push("momentum court terme positif");
  } else if (context.velocity < 0) {
    pYes -= Math.min(0.08, Math.abs(context.velocity) * 80);
    reasons.push("momentum court terme négatif");
  }

  if (context.dailyAnalysis.dailyBias === "bullish") {
    pYes += 0.04 * context.dailyAnalysis.riskMultiplier;
    reasons.push("daily bias haussier");
  } else if (context.dailyAnalysis.dailyBias === "bearish") {
    pYes -= 0.04 * context.dailyAnalysis.riskMultiplier;
    reasons.push("daily bias baissier");
  }

  pYes += (context.mtfAnalysis.alignmentScore - 50) / 1_000;
  pYes = clampProbability(pYes);
  const uncertainty = clampProbability((100 - context.mtfAnalysis.alignmentScore) / 140 + context.spreadPercent / 100);
  const confidence = clampProbability(1 - uncertainty);

  return {
    confidence,
    pNo: clampProbability(1 - pYes),
    pYes,
    reasons: reasons.length === 0 ? ["signal neutre, observation uniquement"] : reasons,
    uncertainty,
  };
}

function buildV3ForecastForContext(context: ReturnType<typeof buildDecisionContext>): FinalSettlementForecast {
  const input = buildFinalSettlementInput(context);
  return input === null ? createFallbackFinalSettlementForecast(context) : evaluateFinalSettlementForecast(input);
}

function buildFinalSettlementInput(context: ReturnType<typeof buildDecisionContext>): FinalSettlementInput | null {
  if (context.currentPrice === null || context.targetPrice === null) {
    return null;
  }

  return {
    asset: context.asset,
    currentPrice: context.currentPrice,
    isOpeningScenarioBot: context.bot.profile === "opening_scenario_bot",
    marketRegime: toEngineMarketRegime(resolveRegime(context)),
    ohlcv15m: buildCandlesFromPoints(context.points, context.currentPrice, 15 * 60_000, 3),
    ohlcv1d: buildCandlesFromPoints(context.points, context.currentPrice, 24 * 60 * 60_000, 3),
    ohlcv1h: buildCandlesFromPoints(context.points, context.currentPrice, 60 * 60_000, 3),
    ohlcv1m: buildCandlesFromPoints(context.points, context.currentPrice, 60_000, 4),
    ohlcv3m: buildCandlesFromPoints(context.points, context.currentPrice, 3 * 60_000, 3),
    ohlcv4h: buildCandlesFromPoints(context.points, context.currentPrice, 4 * 60 * 60_000, 3),
    ohlcv5m: buildCandlesFromPoints(context.points, context.currentPrice, 5 * 60_000, 3),
    targetPrice: context.targetPrice,
    timeRemainingSeconds: context.timeToExpirySeconds,
    volumeProfile: {
      volumeSpikeScore: 0,
      vwap: calculateVwapFromPoints(context.points) ?? context.currentPrice,
    },
  };
}

function buildCandlesFromPoints(points: CryptoChartPoint[], fallbackPrice: number, bucketMs: number, minimumCount: number): Candle[] {
  const buckets = new Map<number, CryptoChartPoint[]>();
  for (const point of points.filter((item) => Number.isFinite(item.price) && Number.isFinite(item.timestamp)).sort((left, right) => left.timestamp - right.timestamp)) {
    const bucket = Math.floor(point.timestamp / bucketMs) * bucketMs;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), point]);
  }

  const candles = Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([timestamp, bucketPoints]) => {
      const prices = bucketPoints.map((point) => point.price);
      return {
        close: prices[prices.length - 1] ?? fallbackPrice,
        high: Math.max(...prices, fallbackPrice),
        low: Math.min(...prices, fallbackPrice),
        open: prices[0] ?? fallbackPrice,
        timestamp,
        volume: bucketPoints.length,
      };
    });

  if (candles.length >= minimumCount) {
    return candles;
  }

  const now = Date.now();
  const synthetic: Candle[] = [];
  for (let index = minimumCount - 1; index >= 0; index -= 1) {
    const drift = index * fallbackPrice * 0.00002;
    const close = fallbackPrice - drift;
    synthetic.push({
      close,
      high: Math.max(close, fallbackPrice),
      low: Math.min(close, fallbackPrice),
      open: close,
      timestamp: now - index * bucketMs,
      volume: 0,
    });
  }
  return synthetic;
}

function calculateVwapFromPoints(points: CryptoChartPoint[]) {
  const valid = points.filter((point) => Number.isFinite(point.price));
  if (valid.length === 0) {
    return null;
  }
  return valid.reduce((total, point) => total + point.price, 0) / valid.length;
}

function toEngineMarketRegime(regime: string): MarketRegime {
  if (regime === "range" || regime === "high_volatility" || regime === "low_liquidity") {
    return regime;
  }
  return "trend";
}

function createFallbackFinalSettlementForecast(context: ReturnType<typeof buildDecisionContext>): FinalSettlementForecast {
  return {
    confidence: 0.4,
    continuationScore: 40,
    currentPositionRelativeToTarget: "NEAR",
    distanceToTargetBps: 0,
    distanceToTargetPercent: 0,
    distanceToTargetUsd: 0,
    explanation: "UNCLEAR: target ou prix crypto en attente, aucune entree paper ouverte.",
    forecast: "UNCLEAR",
    momentumDirection: "NEUTRAL",
    momentumStrength: 0,
    probabilityFinalAbove: 0.5,
    probabilityFinalBelow: 0.5,
    reasonCodes: [context.targetPrice === null ? "TARGET_PENDING" : "CURRENT_PRICE_PENDING", "FORECAST_UNCLEAR"],
    reversalScore: 50,
    trendAlignmentScore: 50,
  };
}

function buildCrypto5mMarketFromContext(context: ReturnType<typeof buildDecisionContext>): Crypto5mMarket {
  const upIndex = findOutcomeIndex(context.market.outcomes, "up", 0);
  const downIndex = findOutcomeIndex(context.market.outcomes, "down", 1);
  return {
    asset: context.asset,
    expiryTime: context.marketEndMs ?? Date.now() + context.timeToExpirySeconds * 1_000,
    liquidityScore: context.liquidityScore,
    marketId: context.marketId,
    noAsk: context.askNo,
    noBid: context.noBid,
    noTokenId: context.market.clobTokenIds[downIndex] ?? "",
    question: context.market.question ?? `${context.asset} Up or Down 5m`,
    rules: context.market.description ?? undefined,
    spreadPercent: context.spreadPercent,
    startTime: context.marketStartMs ?? Date.now(),
    targetPrice: context.targetPrice ?? 0,
    timeRemainingSeconds: context.timeToExpirySeconds,
    yesAsk: context.askYes,
    yesBid: context.yesBid,
    yesTokenId: context.market.clobTokenIds[upIndex] ?? "",
  };
}

function buildOpeningScenarioResultForContext({
  context,
  finalSettlement,
  opportunity,
}: {
  context: ReturnType<typeof buildDecisionContext>;
  finalSettlement: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
}): OpeningScenarioResult | undefined {
  if (context.currentPrice === null || context.targetPrice === null) {
    return undefined;
  }

  return createOpeningScenarios({
    asset: context.asset,
    candles15m: buildCandlesFromPoints(context.points, context.currentPrice, 15 * 60_000, 3),
    candles1d: buildCandlesFromPoints(context.points, context.currentPrice, 24 * 60 * 60_000, 3),
    candles1h: buildCandlesFromPoints(context.points, context.currentPrice, 60 * 60_000, 3),
    candles1m: buildCandlesFromPoints(context.points, context.currentPrice, 60_000, 4),
    candles3m: buildCandlesFromPoints(context.points, context.currentPrice, 3 * 60_000, 3),
    candles4h: buildCandlesFromPoints(context.points, context.currentPrice, 4 * 60 * 60_000, 3),
    candles5m: buildCandlesFromPoints(context.points, context.currentPrice, 5 * 60_000, 3),
    currentPrice: context.currentPrice,
    expiryTime: context.marketEndMs ?? Date.now() + context.timeToExpirySeconds * 1_000,
    finalSettlementForecast: finalSettlement,
    liquidityScore: context.liquidityScore,
    marketId: context.marketId,
    noAsk: context.askNo,
    noBid: context.noBid ?? undefined,
    openingCryptoPrice: context.points.find((point) => context.marketStartMs !== null && point.timestamp >= context.marketStartMs)?.price ?? context.currentPrice,
    opportunity,
    spreadPercent: context.spreadPercent,
    startTime: context.marketStartMs ?? Date.now(),
    targetPrice: context.targetPrice,
    timeRemainingSeconds: context.timeToExpirySeconds,
    yesAsk: context.askYes,
    yesBid: context.yesBid ?? undefined,
  });
}

function evaluatePositionManagementForContext({
  context,
  forecast,
  opportunity,
  positions,
}: {
  context: ReturnType<typeof buildDecisionContext>;
  forecast: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
  positions: SimulatedPosition[];
}) {
  const openPosition = positions.find(
    (position) => position.botId === context.bot.id && position.marketId === context.marketId && position.status === "open",
  );
  if (openPosition === undefined || context.currentPrice === null || context.targetPrice === null) {
    return {
      deRisk: undefined,
      smartScaling: undefined,
    };
  }

  const enginePosition: PaperPosition = {
    addCount: openPosition.addCount ?? 0,
    entrySizeUsd: openPosition.entrySizeUsd,
    entryTokenPrice: openPosition.entryTokenPrice,
    marketId: openPosition.marketId,
    side: openPosition.side,
  };
  const currentTokenPrice = openPosition.side === "YES" ? context.askYes : context.askNo;

  return {
    deRisk: evaluateDeRisk({
      currentTokenPrice,
      forecast,
      opportunity,
      position: enginePosition,
      timeRemainingSeconds: context.timeToExpirySeconds,
    }),
    smartScaling: evaluateSmartScaling({
      currentForecast: forecast,
      currentNoAsk: context.askNo,
      currentOpportunity: opportunity,
      currentPrice: context.currentPrice,
      currentYesAsk: context.askYes,
      position: enginePosition,
      targetPrice: context.targetPrice,
      timeRemainingSeconds: context.timeToExpirySeconds,
    }),
  };
}

function mapMandatoryStatusToBotDecision(status: MarketDecisionStatus): BotDecisionType {
  if (status === "WAITING_FOR_BETTER_PRICE") return "WAITING_FOR_BETTER_PRICE";
  if (status === "WAITING_FOR_CLARITY") return "WAITING_FOR_CLARITY";
  if (status === "NO_TRADE_PRICE_TOO_EXPENSIVE") return "NO_TRADE_PRICE_TOO_EXPENSIVE";
  if (status === "NO_TRADE_LOW_LIQUIDITY") return "NO_TRADE_LOW_LIQUIDITY";
  if (status === "NO_TRADE_WIDE_SPREAD") return "NO_TRADE_WIDE_SPREAD";
  if (status === "NO_TRADE_RISK_BLOCKED") return "NO_TRADE_RISK_BLOCKED";
  return "FORCED_PAPER_PICK_ONLY";
}

function mapOpeningActionToBotDecision(action: OpeningEntryDecision["action"]): BotDecisionType {
  if (action === "FORCED_PAPER_PICK_ONLY") return "FORCED_PAPER_PICK_ONLY";
  if (action === "WAIT_FOR_BETTER_PRICE") return "WAITING_FOR_BETTER_PRICE";
  if (action === "WAIT_FOR_CONFIRMATION") return "WAIT_FOR_CONFIRMATION";
  if (action === "NO_TRADE_PRICE_TOO_EXPENSIVE") return "NO_TRADE_PRICE_TOO_EXPENSIVE";
  return "NO_TRADE";
}

function isRetryableOpeningDecision(decision: BotDecision) {
  const openingAction = decision.diagnostics?.openingEntry?.action;
  if (openingAction === "OPEN_STARTER_POSITION") {
    return false;
  }

  const retryableCodes = new Set([
    "TARGET_PRICE_MISSING",
    "CURRENT_PRICE_PENDING",
    "TARGET_PENDING",
    "target en attente",
    "CRITICAL_DATA_STALE",
    "OPENING_ENTRY_DELAY",
    "OPENING_ENTRY_WINDOW_EXPIRED",
  ]);

  return [...decision.blockedBy, ...decision.reasons, ...(decision.diagnostics?.openingEntry?.reasonCodes ?? []), ...(decision.diagnostics?.finalSettlement?.reasonCodes ?? [])].some(
    (reason) => retryableCodes.has(reason),
  );
}

function isCriticalOpeningDataMissing(snapshot: SimulationSnapshot, market: PublicMarket) {
  const upIndex = findOutcomeIndex(market.outcomes, "up", 0);
  const downIndex = findOutcomeIndex(market.outcomes, "down", 1);
  const yesAsk = readNumber(market.outcomePrices[upIndex]);
  const noAsk = readNumber(market.outcomePrices[downIndex]);
  return snapshot.targetPrice === null || snapshot.currentPrice === null || yesAsk === null || noAsk === null;
}

function getPolymarketBookAgeMs(
  market: PublicMarket,
  prices: Record<string, LivePrice>,
  nowMs: number,
  upIndex: number,
  downIndex: number,
) {
  const timestamps = [market.clobTokenIds[upIndex], market.clobTokenIds[downIndex]]
    .map((assetId) => (assetId === undefined ? null : prices[assetId]?.time ?? null))
    .map((time) => (time === null ? NaN : Date.parse(time)))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (timestamps.length === 0) {
    return null;
  }

  return Math.max(0, nowMs - Math.max(...timestamps));
}

function resolveMarketPhase(state: CryptoMarketState, elapsedSinceStartSeconds: number, timeToExpirySeconds: number) {
  if (state === "BEFORE_START") return "before_start";
  if (state === "RESOLVING") return "resolving";
  if (state === "RESOLVED") return "resolved";
  if (elapsedSinceStartSeconds < 5) return "early";
  if (timeToExpirySeconds <= 20) return "late";
  return "entry_window";
}

function estimateWindowVolatility(points: CryptoChartPoint[], windowStartMs: number) {
  const windowPoints = points.filter((point) => point.timestamp >= windowStartMs);
  return estimateRecentVolatility(windowPoints);
}

function calculateSignalScore(context: ReturnType<typeof buildDecisionContext>, estimate: ProbabilityEstimate) {
  const directionStrength = Math.abs(estimate.pYes - 0.5) * 200;
  const confidenceScore = estimate.confidence * 100;
  const mtfScore = context.mtfAnalysis.alignmentScore;
  const distanceScore = Math.min(100, context.distanceToTargetBps * 2);
  return Math.round(Math.max(0, Math.min(100, directionStrength * 0.3 + confidenceScore * 0.3 + mtfScore * 0.25 + distanceScore * 0.15)));
}

function calculateContradictionScore(context: ReturnType<typeof buildDecisionContext>, side: "YES" | "NO") {
  let score = 0;
  if (side === "YES" && context.velocity < 0) score += 1;
  if (side === "NO" && context.velocity > 0) score += 1;
  if (side === "YES" && context.dailyAnalysis.dailyBias === "bearish") score += 1;
  if (side === "NO" && context.dailyAnalysis.dailyBias === "bullish") score += 1;
  if (context.mtfAnalysis.contradictions.length > 0) score += 1;
  return score;
}

function calculateTargetComparator(
  context: ReturnType<typeof buildDecisionContext>,
  edge: ReturnType<typeof calculateEdge>,
  thresholds: {
    minRequiredEdgeNo: number;
    minRequiredEdgeYes: number;
  },
): TargetComparatorResult {
  const rules = getBotRules(context.bot);
  const reasons: string[] = [];
  const minimumCushionBpsForTrade = Math.max(0, rules.targetDistance.minDistanceFromTargetBps);
  const minimumAtrCushionRatio = Math.max(0.01, rules.targetDistance.minVolatilityAdjustedDistance);
  const liquidity = context.market.liquidity;
  const volatility = Math.max(context.volatility1m, context.volatility5m, 0.00005);
  const currentPrice = context.currentPrice;
  const targetPrice = context.targetPrice;
  const distanceToTargetUsd = currentPrice !== null && targetPrice !== null ? currentPrice - targetPrice : null;
  const distanceToTargetPercent = distanceToTargetUsd !== null && targetPrice !== null ? (distanceToTargetUsd / Math.max(targetPrice, 1)) * 100 : null;
  const signedDistanceBps = distanceToTargetPercent === null ? null : distanceToTargetPercent * 100;
  const absoluteDistanceBps = signedDistanceBps === null ? null : Math.abs(signedDistanceBps);
  const volatilityAdjustedDistance =
    distanceToTargetUsd === null || targetPrice === null ? 0 : Math.abs(distanceToTargetUsd / Math.max(targetPrice, 1)) / volatility;
  const atrCushionRatio = volatilityAdjustedDistance;
  const cushionScore = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        ((absoluteDistanceBps ?? 0) / Math.max(minimumCushionBpsForTrade, 1)) * 30 +
          (atrCushionRatio / Math.max(minimumAtrCushionRatio, 0.01)) * 35 +
          Math.min(35, context.timeToExpirySeconds / 4),
      ),
    ),
  );
  const contradictionScoreForYes = calculateContradictionScore(context, "YES");
  const contradictionScoreForNo = calculateContradictionScore(context, "NO");
  const reversalRisk = Math.round(
    Math.max(
      0,
      Math.min(100, 100 - cushionScore + Math.min(25, Math.max(contradictionScoreForYes, contradictionScoreForNo) * 8) + (context.timeToExpirySeconds < 45 ? 10 : 0)),
    ),
  );
  const targetState = resolveTargetState(signedDistanceBps, minimumCushionBpsForTrade);
  const bullishConfirmed = isShortTermDirectionConfirmed(context, "YES");
  const bearishConfirmed = isShortTermDirectionConfirmed(context, "NO");
  const hasContradictoryTimeframes = context.mtfAnalysis.contradictions.length > 0;
  const yesEdgePercent = edge.edgeYes * 100;
  const noEdgePercent = edge.edgeNo * 100;
  let tradeableSide: TradeableSide = "NONE";
  let decision: BotDecisionType = "NO_TRADE";
  let triggerValidated = false;

  if (currentPrice === null) {
    reasons.push("target comparator: current price pending");
  } else if (targetPrice === null) {
    reasons.push("target comparator: target pending");
  } else if (absoluteDistanceBps !== null && absoluteDistanceBps < minimumCushionBpsForTrade) {
    reasons.push("target comparator: price near target");
  } else if (atrCushionRatio < minimumAtrCushionRatio) {
    reasons.push("target comparator: ATR cushion too low");
  } else if (signedDistanceBps !== null && signedDistanceBps > 0) {
    triggerValidated = context.velocity >= 0 || context.dailyAnalysis.allowedDirection.includes("YES");
    if (hasContradictoryTimeframes) {
      decision = "WAITING_FOR_CLARITY";
      reasons.push("target comparator: contradictory timeframes");
    } else if (!bullishConfirmed || !triggerValidated) {
      decision = "WAITING_FOR_TRIGGER";
      reasons.push("target comparator: waiting bullish trigger");
    } else if (yesEdgePercent < thresholds.minRequiredEdgeYes) {
      decision = "NO_TRADE_PRICE_TOO_EXPENSIVE";
      reasons.push("target comparator: YES too expensive");
    } else {
      tradeableSide = "YES";
      decision = "BUY_YES";
      reasons.push("target comparator: BUY YES allowed");
    }
  } else if (signedDistanceBps !== null && signedDistanceBps < 0) {
    triggerValidated = context.velocity <= 0 || context.dailyAnalysis.allowedDirection.includes("NO");
    if (hasContradictoryTimeframes) {
      decision = "WAITING_FOR_CLARITY";
      reasons.push("target comparator: contradictory timeframes");
    } else if (!bearishConfirmed || !triggerValidated) {
      decision = "WAITING_FOR_TRIGGER";
      reasons.push("target comparator: waiting bearish trigger");
    } else if (noEdgePercent < thresholds.minRequiredEdgeNo) {
      decision = "NO_TRADE_PRICE_TOO_EXPENSIVE";
      reasons.push("target comparator: NO too expensive");
    } else {
      tradeableSide = "NO";
      decision = "BUY_NO";
      reasons.push("target comparator: BUY NO allowed");
    }
  }

  return {
    asset: context.asset,
    atrCushionRatio,
    bearishConfirmed,
    bullishConfirmed,
    cushionScore,
    currentPrice,
    decision,
    distanceToTargetBps: signedDistanceBps,
    distanceToTargetPercent,
    distanceToTargetUsd,
    expiryTime: context.expiryTime,
    liquidity,
    marketId: context.marketId,
    minimumAtrCushionRatio,
    minimumCushionBpsForTrade,
    noAsk: context.askNo,
    reasons,
    requiredMoveToFlipTarget: distanceToTargetUsd === null ? null : Math.abs(distanceToTargetUsd),
    reversalRisk,
    spread: context.spreadPercent,
    startTime: context.startTime,
    targetPrice,
    targetState,
    timeToExpirySeconds: context.timeToExpirySeconds,
    tradeableSide,
    triggerValidated,
    volatilityAdjustedDistance,
    yesAsk: context.askYes,
  };
}

function resolveTargetState(signedDistanceBps: number | null, minimumCushionBpsForTrade: number): TargetState {
  if (signedDistanceBps === null || Math.abs(signedDistanceBps) < minimumCushionBpsForTrade) {
    return "NEAR_TARGET";
  }
  if (signedDistanceBps > 0) {
    return signedDistanceBps >= minimumCushionBpsForTrade * 2 ? "ABOVE_TARGET_STRONG" : "ABOVE_TARGET_WEAK";
  }
  return Math.abs(signedDistanceBps) >= minimumCushionBpsForTrade * 2 ? "BELOW_TARGET_STRONG" : "BELOW_TARGET_WEAK";
}

function isShortTermDirectionConfirmed(context: ReturnType<typeof buildDecisionContext>, side: "YES" | "NO") {
  if (side === "YES") {
    return (
      context.currentPrice !== null &&
      context.targetPrice !== null &&
      context.currentPrice > context.targetPrice &&
      (context.mtfAnalysis.trend1m === "bullish" || context.mtfAnalysis.trend15m === "bullish" || context.dailyAnalysis.dailyBias === "bullish")
    );
  }

  return (
    context.currentPrice !== null &&
    context.targetPrice !== null &&
    context.currentPrice < context.targetPrice &&
    (context.mtfAnalysis.trend1m === "bearish" || context.mtfAnalysis.trend15m === "bearish" || context.dailyAnalysis.dailyBias === "bearish")
  );
}

function calculateAgreementCount(context: ReturnType<typeof buildDecisionContext>, side: "YES" | "NO") {
  const wantsYes = side === "YES";
  const checks = [
    wantsYes ? context.dailyAnalysis.dailyBias === "bullish" : context.dailyAnalysis.dailyBias === "bearish",
    wantsYes ? context.mtfAnalysis.trend1h === "bullish" : context.mtfAnalysis.trend1h === "bearish",
    wantsYes ? context.velocity > 0 : context.velocity < 0,
    context.spreadPercent <= 3,
    context.liquidityScore >= 70,
  ];
  return checks.filter(Boolean).length;
}

function resolveRegime(context: ReturnType<typeof buildDecisionContext>) {
  if (context.liquidityScore < 50) return "low_liquidity";
  if (context.volatility5m > 0.003) return "high_volatility";
  if (context.mtfAnalysis.trend1h === "range") return "range";
  return "trend";
}

function buildDecisionDiagnostics({
  context,
  deRisk,
  effectiveRiskPercent,
  entryOpportunity,
  estimate,
  finalSettlement,
  forcedPaperPick,
  marketState,
  minRequiredEdgePercent,
  openingEntry,
  openingScenario,
  openingSettings,
  side,
  smartScaling,
  targetComparator,
}: {
  context: ReturnType<typeof buildDecisionContext>;
  deRisk?: DeRiskDecision;
  effectiveRiskPercent: number;
  entryOpportunity?: EntryOpportunityResult;
  estimate: ProbabilityEstimate;
  finalSettlement?: FinalSettlementForecast;
  forcedPaperPick?: ForcedPaperPick;
  marketState: CryptoMarketState;
  minRequiredEdgePercent: number;
  openingEntry?: OpeningEntryDecision;
  openingScenario?: OpeningScenarioResult;
  openingSettings?: OpeningScenarioSettings;
  side: "YES" | "NO";
  smartScaling?: SmartScalingDecision;
  targetComparator: TargetComparatorResult;
}): BotDecisionDiagnostics {
  const signalScore = calculateSignalScore(context, estimate);
  const contradictionScore = calculateContradictionScore(context, side);
  return {
    agreementCount: calculateAgreementCount(context, side),
    contradictionScore,
    cryptoPrice: context.currentPrice ?? null,
    cvdScore: 0,
    dataAgeMs: context.cryptoPriceAgeMs,
    distanceToTargetBps: context.targetPrice === null ? null : context.distanceToTargetBps,
    distanceToTargetPercent: context.targetPrice === null ? null : context.distanceToTarget * 100,
    effectiveRiskPercentPerTrade: effectiveRiskPercent,
    deRisk,
    entryOpportunity,
    finalSettlement,
    forcedPaperPick,
    latencyMs: context.cryptoPriceAgeMs,
    liquidityScore: context.liquidityScore,
    marketPhase: context.marketPhase,
    marketState,
    minRequiredEdgePercent,
    modelVersion: "black_goat_v3_final_settlement_001",
    noBid: context.noBid,
    orderbookImbalanceCrypto: 0,
    orderbookImbalancePolymarket: 0,
    openingEntry,
    openingNearTargetOverrideUsed: finalSettlement?.openingNearTargetOverrideUsed ?? false,
    openingScenario,
    openingSettings,
    preOpenBiasDirection: finalSettlement?.preOpenBiasDirection,
    preOpenBiasScore: finalSettlement?.preOpenBiasScore,
    legacySignalScoreIgnored: context.bot.profile === "opening_scenario_bot",
    primaryScenarioKeptDespiteNoTrade: openingScenario?.primaryScenarioKeptDespiteNoTrade ?? false,
    forcedMinStakePaperUsed: openingEntry?.forcedMinStakePaperUsed ?? false,
    lateForcedEntryUsed: openingEntry?.lateForcedEntryUsed ?? false,
    regime: resolveRegime(context),
    side,
    signalScore,
    slippageEstimatePercent: context.slippageEstimate * 100,
    spreadPercent: context.spreadPercent,
    strategyMode: context.bot.modelMode,
    smartScaling,
    targetPrice: context.targetPrice,
    targetComparator,
    timeToExpirySeconds: context.timeToExpirySeconds,
    volatility1m: context.volatility1m,
    volatility5m: context.volatility5m,
    volumeSpikeScore: 0,
    yesBid: context.yesBid,
  };
}

function calculateEdge({
  askNo,
  askYes,
  pNo,
  pYes,
  safetyMargin,
  slippageEstimate,
  uncertaintyPenalty,
}: {
  askNo: number;
  askYes: number;
  pNo: number;
  pYes: number;
  safetyMargin: number;
  slippageEstimate: number;
  uncertaintyPenalty: number;
}) {
  return {
    edgeNo: pNo - askNo - slippageEstimate - uncertaintyPenalty - safetyMargin,
    edgeYes: pYes - askYes - slippageEstimate - uncertaintyPenalty - safetyMargin,
  };
}

function getMinimumEdgePercentForTrade(bot: BotConfig, asset: BotAsset, side: "YES" | "NO") {
  const rules = getBotRules(bot);
  const assetRule = rules.assetRules[asset];
  const sideMinimum = side === "YES" ? rules.edge.minEdgePercentForYES : rules.edge.minEdgePercentForNO;
  return Math.max(rules.edge.minEdgePercent, Math.min(bot.minEdgePercent, sideMinimum, assetRule.minEdgePercent));
}

function validateBotTradeV2(
  bot: BotConfig,
  context: {
    agreementCount: number;
    asset: BotAsset;
    botPositions: SimulatedPosition[];
    confidence: number;
    contradictionScore: number;
    cryptoPriceAgeMs: number | null;
    dailyAnalysis: DailyAnalysis;
    decisions: BotDecision[];
    diagnostics: BotDecisionDiagnostics;
    edgeNet: number;
    liquidityScore: number;
    marketState: CryptoMarketState;
    marketId: string;
    marketPhase: string;
    mtfAnalysis: MultiTimeframeAnalysis;
    nowMs: number;
    polymarketBookAgeMs: number | null;
    side: "YES" | "NO";
    signalScore: number;
    stats: BotPerformanceStats;
    spreadPercent: number;
    targetPrice: number | null;
    targetComparator: TargetComparatorResult;
    timeToExpirySeconds: number;
    todayDecisionCount: number;
    tradesToday: number;
  },
) {
  const rules = getBotRules(bot);
  const assetRule = rules.assetRules[context.asset];
  const blockedBy: string[] = [];
  const openPositionsList = context.botPositions.filter((position) => position.status === "open");
  const positionsOnMarket = context.botPositions.filter((position) => position.marketId === context.marketId);
  const positionsOnAssetMarket = positionsOnMarket.filter((position) => position.asset === context.asset);
  const openSameDirection = openPositionsList.filter((position) => position.side === context.side).length;
  const correlatedOpenPositions = openPositionsList.filter((position) => BOT_ASSETS.includes(position.asset)).length;
  const lastExecutedSameAssetPosition = context.botPositions
    .filter((position) => position.asset === context.asset && position.entryTimestamp <= context.nowMs)
    .sort((left, right) => right.entryTimestamp - left.entryTimestamp)[0];
  const lastLoss = context.botPositions
    .filter((position) => (position.pnlUsd ?? 0) < 0 && position.exitTimestamp !== undefined)
    .sort((left, right) => (right.exitTimestamp ?? 0) - (left.exitTimestamp ?? 0))[0];
  const lastSameAssetLoss = context.botPositions
    .filter((position) => position.asset === context.asset && (position.pnlUsd ?? 0) < 0 && position.exitTimestamp !== undefined)
    .sort((left, right) => (right.exitTimestamp ?? 0) - (left.exitTimestamp ?? 0))[0];
  const maxAllowedSpread = Math.max(bot.maxSpreadPercent, assetRule.maxSpreadPercent, rules.marketQuality.maxSpreadPercent);
  const isOpeningScenarioBot = bot.profile === "opening_scenario_bot";
  const dailyPnlUsd = context.botPositions
    .filter((position) => position.exitTimestamp !== undefined && isSameUtcDay(position.exitTimestamp, context.nowMs))
    .reduce((total, position) => total + (position.pnlUsd ?? 0), 0);

  if (bot.currentBalance <= 0) blockedBy.push("capital fictif insuffisant");
  if (!assetRule.enabled) blockedBy.push(assetRule.reason ?? "asset disabled by Normal V2");
  if (context.spreadPercent > maxAllowedSpread) blockedBy.push("spread too wide");
  if (context.liquidityScore < Math.min(bot.minLiquidityScore, rules.marketQuality.minLiquidityScore)) blockedBy.push("liquidity too low");
  if (isOpeningScenarioBot) {
    if (context.timeToExpirySeconds < BLACK_GOAT_V3_CONFIG.starterEntry.minTimeRemainingSeconds) blockedBy.push("time to expiry too low");
    if (context.timeToExpirySeconds > BLACK_GOAT_V3_CONFIG.starterEntry.maxTimeRemainingSeconds) blockedBy.push("time to expiry too high");
  } else {
    if (context.timeToExpirySeconds < Math.min(bot.minTimeToExpirySeconds, 20)) blockedBy.push("time to expiry too low");
    if (context.timeToExpirySeconds > Math.max(bot.maxTimeToExpirySeconds, 280)) blockedBy.push("time to expiry too high");
  }
  if (!isOpeningScenarioBot && context.marketPhase === "early") blockedBy.push("avoid first seconds");
  if (context.marketPhase === "late") blockedBy.push("avoid last seconds");
  if (context.targetPrice === null) blockedBy.push("target en attente");
  if (context.marketState !== "LIVE") blockedBy.push("market not live");
  if (openPositionsList.length >= Math.max(bot.maxOpenPositions, rules.positionLimits.maxOpenPositions)) blockedBy.push("too many open positions");
  if (openSameDirection >= rules.positionLimits.maxOpenPositionsSameDirection) blockedBy.push("too many same-direction positions");
  if (correlatedOpenPositions >= rules.positionLimits.maxCorrelatedPositions) blockedBy.push("correlated crypto exposure too high");
  if (!rules.positionLimits.allowPyramiding && positionsOnMarket.some((position) => position.status === "open")) blockedBy.push("pyramiding disabled");
  if (positionsOnMarket.length >= rules.positionLimits.maxEntriesPerMarket) blockedBy.push("max entries per market reached");
  if (positionsOnAssetMarket.length >= rules.positionLimits.maxEntriesPerAssetPerMarket) blockedBy.push("max entries per asset/market reached");
  if (context.tradesToday >= bot.maxTradesPerDay) blockedBy.push("daily trades limit reached");
  if (!isOpeningScenarioBot && context.mtfAnalysis.alignmentScore < 60) blockedBy.push("multi-timeframe contradiction");
  if (!isOpeningScenarioBot && context.confidence < rules.signalQuality.minModelConfidenceToTrade) blockedBy.push("model confidence too low");
  if (!isOpeningScenarioBot && context.signalScore < rules.signalQuality.minSignalScoreToTrade) blockedBy.push("signal score too low");
  if (!isOpeningScenarioBot && rules.signalQuality.neutralSignalForcesNoTrade && context.dailyAnalysis.dailyBias === "neutral") blockedBy.push("neutral signal forces no trade");
  if (!isOpeningScenarioBot && context.agreementCount < rules.signalQuality.minAgreementCount) blockedBy.push("signal agreement too low");
  if (!isOpeningScenarioBot && rules.signalQuality.blockContradictorySignals && context.contradictionScore > rules.signalQuality.maxContradictionScore) {
    blockedBy.push("contradictory signals");
  }
  if (context.stats.consecutiveLosses >= rules.risk.maxConsecutiveLossesBeforePause) blockedBy.push("pause after consecutive losses");
  if (context.stats.maxDrawdownPercent >= rules.risk.maxDrawdownBeforeStopPercent) blockedBy.push("drawdown stop reached");
  else if (context.stats.maxDrawdownPercent >= rules.risk.maxDrawdownBeforePausePercent) blockedBy.push("drawdown pause reached");
  if (dailyPnlUsd <= -rules.risk.maxDailyLossUsd) blockedBy.push("daily loss limit reached");
  if (
    lastExecutedSameAssetPosition !== undefined &&
    context.nowMs - lastExecutedSameAssetPosition.entryTimestamp < rules.timing.cooldownAfterTradeSeconds * 1_000
  ) {
    blockedBy.push("cooldown after trade");
  }
  if (lastLoss?.exitTimestamp !== undefined && context.nowMs - lastLoss.exitTimestamp < rules.timing.cooldownAfterLossSeconds * 1_000) {
    blockedBy.push("cooldown after loss");
  }
  if (
    lastSameAssetLoss?.exitTimestamp !== undefined &&
    context.nowMs - lastSameAssetLoss.exitTimestamp < rules.timing.cooldownAfterMarketLossSameAssetSeconds * 1_000
  ) {
    blockedBy.push("cooldown after same-asset loss");
  }
  if (
    rules.dataFreshness.blockIfAnyCriticalDataStale &&
    context.cryptoPriceAgeMs !== null &&
    context.cryptoPriceAgeMs > rules.dataFreshness.maxCryptoPriceAgeMs
  ) {
    blockedBy.push("stale crypto price");
  }
  if (
    rules.dataFreshness.blockIfAnyCriticalDataStale &&
    context.polymarketBookAgeMs !== null &&
    context.polymarketBookAgeMs > rules.dataFreshness.maxPolymarketBookAgeMs
  ) {
    blockedBy.push("stale Polymarket book");
  }
  if (context.edgeNet <= 0) blockedBy.push("negative net edge");

  return {
    adjustedPositionSize: blockedBy.length === 0 ? calculatePaperPositionSizeV2(bot, context) : 0,
    approved: blockedBy.length === 0,
    blockedBy,
  };
}

function calculatePaperPositionSizeV2(
  bot: BotConfig,
  context: {
    asset: BotAsset;
    confidence: number;
    dailyAnalysis: DailyAnalysis;
    diagnostics: BotDecisionDiagnostics;
    liquidityScore: number;
    spreadPercent: number;
  },
) {
  const rules = getBotRules(bot);
  const assetRule = rules.assetRules[context.asset];
  const baseSize = bot.currentBalance * (bot.riskPercentPerTrade / 100);
  const confidenceMultiplier = Math.max(0.35, Math.min(1.15, context.confidence));
  const liquidityMultiplier = Math.max(0.25, Math.min(1, context.liquidityScore / 100));
  const spreadReducer = context.spreadPercent > Math.min(bot.maxSpreadPercent, rules.marketQuality.maxSpreadPercent) * 0.75 ? 0.65 : 1;
  const regimeMultiplier =
    context.diagnostics.regime === "high_volatility"
      ? rules.marketRegime.riskMultiplierHighVolatility
      : context.diagnostics.regime === "range"
        ? rules.marketRegime.riskMultiplierRange
        : context.diagnostics.regime === "low_liquidity"
          ? 0
          : rules.marketRegime.riskMultiplierTrend;
  const rawSize =
    baseSize *
    context.dailyAnalysis.riskMultiplier *
    confidenceMultiplier *
    liquidityMultiplier *
    spreadReducer *
    regimeMultiplier *
    assetRule.riskMultiplier;
  const cappedSize = Math.min(rules.risk.maxPositionSizeUsd, rawSize);

  return Math.max(rules.risk.minOrderSizeUsd, cappedSize);
}

function validateBotTrade(
  bot: BotConfig,
  context: {
    botPositions: SimulatedPosition[];
    confidence: number;
    dailyAnalysis: DailyAnalysis;
    edgeNet: number;
    liquidityScore: number;
    marketState: CryptoMarketState;
    mtfAnalysis: MultiTimeframeAnalysis;
    nowMs: number;
    spreadPercent: number;
    targetPrice: number | null;
    timeToExpirySeconds: number;
    todayDecisionCount: number;
    tradesToday: number;
  },
) {
  const blockedBy: string[] = [];
  const openPositions = context.botPositions.filter((position) => position.status === "open").length;

  if (bot.currentBalance <= 0) blockedBy.push("capital fictif insuffisant");
  if (context.spreadPercent > bot.maxSpreadPercent) blockedBy.push("spread trop large");
  if (context.liquidityScore < bot.minLiquidityScore) blockedBy.push("liquidité faible");
  if (context.timeToExpirySeconds < bot.minTimeToExpirySeconds) blockedBy.push("temps restant trop faible");
  if (context.timeToExpirySeconds > bot.maxTimeToExpirySeconds) blockedBy.push("temps restant trop long");
  if (context.targetPrice === null) blockedBy.push("target en attente");
  if (context.marketState !== "LIVE") blockedBy.push("marché non live");
  if (openPositions >= bot.maxOpenPositions) blockedBy.push("trop de positions ouvertes");
  if (context.tradesToday >= bot.maxTradesPerDay) blockedBy.push("limite trades/jour atteinte");
  if (context.mtfAnalysis.alignmentScore < 60) blockedBy.push("contradiction multi-timeframe");
  if (context.confidence < 0.52) blockedBy.push("modèle trop incertain");
  if (context.edgeNet <= 0) blockedBy.push("edge net négatif");

  return {
    adjustedPositionSize: blockedBy.length === 0 ? calculatePaperPositionSize(bot, context) : 0,
    approved: blockedBy.length === 0,
    blockedBy,
  };
}

function calculatePaperPositionSize(
  bot: BotConfig,
  context: {
    confidence: number;
    dailyAnalysis: DailyAnalysis;
    liquidityScore: number;
    spreadPercent: number;
  },
) {
  const baseSize = bot.currentBalance * (bot.riskPercentPerTrade / 100);
  const confidenceMultiplier = Math.max(0.35, Math.min(1.15, context.confidence));
  const liquidityMultiplier = Math.max(0.25, Math.min(1, context.liquidityScore / 100));
  const spreadReducer = context.spreadPercent > bot.maxSpreadPercent * 0.75 ? 0.65 : 1;
  const profileCap = bot.profile === "risquee" ? 30 : bot.profile === "scalping" ? 8 : 18;

  return Math.max(1, Math.min(profileCap, baseSize * context.dailyAnalysis.riskMultiplier * confidenceMultiplier * liquidityMultiplier * spreadReducer));
}

function resolvePaperPositions({
  botId,
  currentPrice,
  market,
  nowMs,
  positions,
  targetPrice,
}: {
  botId: string;
  currentPrice: number | null;
  market: PublicMarket;
  nowMs: number;
  positions: SimulatedPosition[];
  targetPrice: number | null;
}) {
  const marketId = getMarketKey(market);
  const marketEndMs = market.endDate === null ? null : Date.parse(market.endDate);
  if (marketEndMs === null || Number.isNaN(marketEndMs) || nowMs < marketEndMs || targetPrice === null || currentPrice === null) {
    return positions;
  }

  let changed = false;
  const finalOutcome: "YES" | "NO" = currentPrice >= targetPrice ? "YES" : "NO";
  const nextPositions = positions.map((position) => {
    if (position.botId !== botId || position.marketId !== marketId || position.status !== "open") {
      return position;
    }

    changed = true;
    const won = position.side === finalOutcome;
    const pnlUsd = won ? position.entrySizeUsd * (1 / Math.max(position.entryTokenPrice, 0.01) - 1) : -position.entrySizeUsd;
    return {
      ...position,
      exitCryptoPrice: currentPrice,
      exitTimestamp: nowMs,
      exitTokenPrice: won ? 1 : 0,
      finalOutcome,
      pnlPercent: (pnlUsd / position.entrySizeUsd) * 100,
      pnlUsd,
      status: "resolved" as const,
    };
  });

  return changed ? nextPositions : positions;
}

function calculatePerformanceStats(
  bot: BotConfig,
  positions: SimulatedPosition[],
  decisions: BotDecision[],
): BotPerformanceStats {
  const resolved = positions.filter((position) => position.pnlUsd !== undefined);
  const wins = resolved.filter((position) => (position.pnlUsd ?? 0) > 0);
  const losses = resolved.filter((position) => (position.pnlUsd ?? 0) < 0);
  const totalPnlUsd = resolved.reduce((total, position) => total + (position.pnlUsd ?? 0), 0);
  const grossWin = wins.reduce((total, position) => total + (position.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((total, position) => total + (position.pnlUsd ?? 0), 0));
  const currentBalance = bot.startingBalance + totalPnlUsd;
  const equityValues = buildEquityValues(bot.startingBalance, resolved);

  return {
    averageEdgePercent: decisions.length === 0 ? 0 : (decisions.reduce((total, decision) => total + decision.edgeNet * 100, 0) / decisions.length),
    averageLossUsd: losses.length === 0 ? 0 : grossLoss / losses.length,
    averageWinUsd: wins.length === 0 ? 0 : grossWin / wins.length,
    blockedTradeCount: decisions.filter((decision) => decision.blockedBy.length > 0).length,
    botId: bot.id,
    consecutiveLosses: countConsecutiveLosses(resolved),
    currentBalance,
    fillRate: decisions.length === 0 ? 0 : (positions.length / decisions.length) * 100,
    maxDrawdownPercent: calculateMaxDrawdown(equityValues),
    noTradeCount: decisions.filter((decision) => decision.decision === "NO_TRADE").length,
    openPositionsCount: positions.filter((position) => position.status === "open").length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? grossWin : 0) : grossWin / grossLoss,
    startingBalance: bot.startingBalance,
    totalPnlPercent: bot.startingBalance <= 0 ? 0 : (totalPnlUsd / bot.startingBalance) * 100,
    totalPnlUsd,
    tradesCount: positions.length,
    winRate: resolved.length === 0 ? 0 : (wins.length / resolved.length) * 100,
  };
}

function buildDailyAnalysis(asset: BotAsset, snapshot: SimulationSnapshot, nowMs: number): DailyAnalysis {
  const velocity = calculatePriceVelocity(snapshot.points);
  const diff =
    snapshot.currentPrice !== null && snapshot.targetPrice !== null
      ? snapshot.currentPrice - snapshot.targetPrice
      : 0;
  const dailyBias = diff > 0 ? "bullish" : diff < 0 ? "bearish" : velocity > 0 ? "bullish" : velocity < 0 ? "bearish" : "neutral";
  const volatility = estimateRecentVolatility(snapshot.points);

  return {
    allowedDirection: dailyBias === "bullish" ? ["YES"] : dailyBias === "bearish" ? ["NO"] : ["YES", "NO"],
    asset,
    avoidConditions: volatility > 0.003 ? ["volatilité élevée", "réduire la taille"] : ["surveiller spread", "valider target"],
    confidence: Math.max(0.45, Math.min(0.78, 0.58 + Math.abs(velocity) * 20)),
    dailyBias,
    riskMultiplier: volatility > 0.003 ? 0.6 : 1,
    volatilityRegime: volatility > 0.003 ? "high" : volatility < 0.0007 ? "low" : "normal",
  };
}

function buildMultiTimeframeAnalysis(asset: BotAsset, snapshot: SimulationSnapshot): MultiTimeframeAnalysis {
  const velocity = calculatePriceVelocity(snapshot.points);
  const direction = velocity > 0 ? "bullish" : velocity < 0 ? "bearish" : "neutral";
  const targetSignal =
    snapshot.currentPrice !== null && snapshot.targetPrice !== null
      ? snapshot.currentPrice >= snapshot.targetPrice
        ? "above target"
        : "below target"
      : "target pending";
  const alignmentScore = Math.max(35, Math.min(88, 62 + Math.round(velocity * 1_500)));

  return {
    alignmentScore,
    conclusion: `${asset} ${direction}, ${targetSignal}. Le bot réduit ou bloque si l’alignement passe sous 60.`,
    contradictions: alignmentScore < 60 ? ["momentum court terme contradictoire"] : [],
    trend15m: direction,
    trend1h: direction,
    trend1m: direction,
    trend4h: direction === "neutral" ? "range" : direction,
    trend5m: targetSignal,
    trendDaily: direction === "neutral" ? "range" : direction,
  };
}

const TopTraderRow = memo(function TopTraderRow({
  compact = false,
  nowMs,
  sort,
  trader,
}: {
  compact?: boolean;
  nowMs: number;
  sort: TopTraderSort;
  trader: TopTrader;
}) {
  const rawName = trader.username ?? trader.wallet;
  const displayName = rawName === trader.wallet || rawName.startsWith("0x") || rawName.length > 22 ? shortWallet(trader.wallet) : rawName;
  const showPnl = sort === "pnl" && trader.pnl !== null;
  const pnlClass = showPnl
    ? trader.pnl === null
      ? "neutral"
      : trader.pnl >= 0
        ? "positive"
        : "negative"
    : trader.scores.globalScore >= 70
      ? "positive"
      : trader.scores.globalScore >= 45
        ? "neutral"
        : "negative";

  return (
    <div className={`top-trader-row ${compact ? "compact-row" : ""}`}>
      <span className="top-rank">#{trader.rank}</span>
      <div className="top-avatar" title={displayName}>
        {trader.profileImage !== null ? <img alt="" src={trader.profileImage} /> : getInitials(displayName)}
      </div>
      <div className="top-identity">
        <a href={trader.profileUrl} rel="noreferrer" target="_blank">
          {displayName}
        </a>
        <span>{trader.mainMarket}</span>
      </div>
      <div className="top-metric">
        <strong>{showPnl ? formatSignedUsd(trader.pnl) : formatUsd(trader.volume)}</strong>
        <span>{showPnl ? "PnL" : "Volume"}</span>
      </div>
      <div className={`top-pnl ${pnlClass}`}>
        {showPnl ? formatSignedUsd(trader.pnl) : `Score ${trader.scores.globalScore}/100`}
      </div>

      <div className="trader-popover" role="tooltip">
        <div className="popover-score">
          <strong>{trader.scores.globalScore}/100</strong>
          <span>Note globale</span>
        </div>
        <div className="popover-stats">
          <Metric label="Risk" value={`${trader.scores.riskScore}/100`} />
          <Metric label="Activity" value={`${trader.scores.activityScore}/100`} />
          <Metric label="Volume" value={`${trader.scores.volumeScore}/100`} />
          <Metric label="Consistency" value={`${trader.scores.consistencyScore}/100`} />
        </div>
        <div className="popover-meta">
          {trader.trades > 0 ? <span>{trader.trades} trades</span> : null}
          {trader.volume > 0 ? <span>{formatUsd(trader.volume)} volume</span> : null}
          {trader.lastActivity !== null ? <span>{formatRelativeTime(trader.lastActivity, nowMs)}</span> : null}
          <span>{trader.mainMarket}</span>
        </div>
      </div>
    </div>
  );
});

function TradersView({
  dataSourceStatus,
  lastUpdate,
  liveTrades,
  loading,
  minTrades,
  minVolume,
  nowMs,
  onRefresh,
  order,
  period,
  rowsPerPage,
  search,
  selectedTrader,
  selectedTraderId,
  setMinTrades,
  setMinVolume,
  setOrder,
  setPeriod,
  setRowsPerPage,
  setSearch,
  setSelectedTraderId,
  setSort,
  setTapePaused,
  setLiveTrades,
  sort,
  tapePaused,
  traders,
  wsMeta,
}: {
  dataSourceStatus: DataSourceStatus;
  lastUpdate: string | null;
  liveTrades: NormalizedTrade[];
  loading: boolean;
  minTrades: string;
  minVolume: string;
  nowMs: number;
  onRefresh: () => Promise<void>;
  order: "asc" | "desc";
  period: PeriodKey;
  rowsPerPage: number;
  search: string;
  selectedTrader: TraderProfileResponse | null;
  selectedTraderId: string | null;
  setMinTrades: (value: string) => void;
  setMinVolume: (value: string) => void;
  setOrder: (order: "asc" | "desc") => void;
  setPeriod: (period: PeriodKey) => void;
  setRowsPerPage: (rows: number) => void;
  setSearch: (search: string) => void;
  setSelectedTraderId: (id: string | null) => void;
  setSort: (sort: TraderSort) => void;
  setTapePaused: (paused: boolean) => void;
  setLiveTrades: (trades: NormalizedTrade[] | ((current: NormalizedTrade[]) => NormalizedTrade[])) => void;
  sort: TraderSort;
  tapePaused: boolean;
  traders: ActiveTrader[];
  wsMeta: TradersWsMeta;
}) {
  const [page, setPage] = useState(1);
  const orderedTraders = useMemo(() => (order === "asc" ? [...traders].reverse() : traders), [order, traders]);
  const pageCount = Math.max(1, Math.ceil(orderedTraders.length / rowsPerPage));
  const safePage = Math.min(page, pageCount);
  const visibleTraders = orderedTraders.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);

  useEffect(() => {
    setPage(1);
  }, [minTrades, minVolume, order, period, rowsPerPage, search, sort]);

  return (
    <section className="trader-grid">
      <div className="trader-main-column">
        <div className="terminal-panel traders-panel">
          <div className="panel-head">
            <div>
              <h2>Active Traders</h2>
              <p>Only public Polymarket trades are aggregated. Missing fields stay unavailable.</p>
            </div>
            <SourceBadge status={dataSourceStatus} />
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
            <label>
              <span>Sort by</span>
              <select
                onChange={(event) => setSort(event.target.value as TraderSort)}
                title="Sort active traders by profile quality or one public aggregation field."
                value={sort}
              >
                <option value="profile_quality">Profile quality</option>
                <option value="indicative_score">Indicative score</option>
                <option value="activity">Activity</option>
                <option value="volume">Volume</option>
                <option value="consistency">Consistency</option>
                <option value="risk">Risk</option>
                <option value="last_activity">Last activity</option>
                <option value="trades">Trades</option>
                <option value="average_placement">Average placement</option>
              </select>
            </label>
            <label>
              <span>Order</span>
              <select onChange={(event) => setOrder(event.target.value as "asc" | "desc")} value={order}>
                <option value="desc">Desc</option>
                <option value="asc">Asc</option>
              </select>
            </label>
            <button onClick={() => void onRefresh()} type="button">
              Refresh
            </button>
          </div>

          <p className="notice">
            Indicative score is an analytical read-only score. It is not financial advice and never creates orders.
          </p>
          <div className="freshness-grid">
            <Metric label="Dernier trade public" value={formatRelativeTime(wsMeta.newestTradeAt, nowMs)} />
            <Metric label="Dernier trade recu live" value={formatRelativeTime(wsMeta.lastTradeEventAt, nowMs)} />
            <Metric label="Dernier event WS" value={formatRelativeTime(wsMeta.lastWsEventAt, nowMs)} />
            <Metric label="WS events/min" value={formatCount(wsMeta.wsEventsPerMinute)} />
            <Metric label="Trades/min" value={formatCount(wsMeta.tradesReceivedPerMinute)} />
          </div>
          <ActiveTraderTable
            loading={loading}
            nowMs={nowMs}
            onSelect={setSelectedTraderId}
            page={safePage}
            pageCount={pageCount}
            rowsPerPage={rowsPerPage}
            selectedId={selectedTraderId}
            setPage={setPage}
            setRowsPerPage={setRowsPerPage}
            totalRows={orderedTraders.length}
            traders={visibleTraders}
          />
        </div>

        <LiveTape
          liveTrades={liveTrades}
          onClear={() => setLiveTrades([])}
          paused={tapePaused}
          setPaused={setTapePaused}
        />
      </div>

      <TraderDetail selectedTrader={selectedTrader} />
    </section>
  );
}

function ActiveTraderTable({
  loading,
  nowMs,
  onSelect,
  page,
  pageCount,
  rowsPerPage,
  selectedId,
  setPage,
  setRowsPerPage,
  totalRows,
  traders,
}: {
  loading: boolean;
  nowMs: number;
  onSelect: (id: string) => void;
  page: number;
  pageCount: number;
  rowsPerPage: number;
  selectedId: string | null;
  setPage: (page: number) => void;
  setRowsPerPage: (rows: number) => void;
  totalRows: number;
  traders: ActiveTrader[];
}) {
  if (loading) {
    return <p className="empty terminal-empty">Loading traders...</p>;
  }

  if (traders.length === 0) {
    return <p className="empty terminal-empty">UNAVAILABLE: no public traders returned for this filter.</p>;
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th title="Wallet, username, or pseudonym returned by Polymarket.">Trader</th>
              <th title="Recent notional volume derived from public trade size x price.">Volume</th>
              <th title="Number of public trades seen in the selected period.">Trades</th>
              <th title="Average amount placed per trade during selected period.">Avg Placement</th>
              <th title="Most recent public trade timestamp from Polymarket, displayed in local relative time.">Last Activity</th>
              <th title="Market title from the latest public trade.">Market</th>
              <th title="Outcome label from the latest public trade.">Outcome</th>
              <th title="Latest public trade price.">Price</th>
              <th title="Read-only analytical score, not financial advice.">Indicative Score</th>
              <th title="Whether this row uses real public Polymarket data or unavailable fields.">Source</th>
            </tr>
          </thead>
          <tbody>
            {traders.map((trader, index) => (
              <tr className={selectedId === trader.id ? "selected" : ""} key={trader.id} onClick={() => onSelect(trader.id)}>
                <td>{(page - 1) * rowsPerPage + index + 1}</td>
                <td>
                  <button className="link-button" title={trader.wallet} type="button">
                    {trader.username ?? trader.pseudonym ?? shortWallet(trader.wallet)}
                  </button>
                  <span className="subtext" title={trader.wallet}>
                    {shortWallet(trader.wallet)}
                  </span>
                </td>
                <td>{formatUsd(trader.volumeRecent)}</td>
                <td>{trader.tradesRecent}</td>
                <td title="Average amount placed per trade during selected period.">
                  {formatUsd(trader.averagePlacement)}
                </td>
                <td>
                  <RelativeTime nowMs={nowMs} value={trader.lastActivity} />
                </td>
                <td className="market-cell" title={trader.market ?? "Unavailable"}>
                  {trader.market ?? "Unavailable"}
                </td>
                <td className="single-line" title={trader.outcome ?? "Unavailable"}>
                  {trader.outcome ?? "Unavailable"}
                </td>
                <td>{formatProbability(trader.price)}</td>
                <td>
                  <ScoreValue value={trader.scores.indicativeScore ?? trader.scores.overallScore} />
                </td>
                <td>
                  <SourceBadge compact status={trader.dataSourceStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination-bar">
        <span>
          Page {page} / {pageCount} | {totalRows} traders
        </span>
        <label>
          Rows per page
          <select onChange={(event) => setRowsPerPage(Number(event.target.value))} value={rowsPerPage}>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <button disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))} type="button">
          Previous
        </button>
        <button disabled={page >= pageCount} onClick={() => setPage(Math.min(pageCount, page + 1))} type="button">
          Next
        </button>
      </div>
    </>
  );
}

function TraderDetail({ selectedTrader }: { selectedTrader: TraderProfileResponse | null }) {
  const [copied, setCopied] = useState(false);

  if (selectedTrader === null) {
    return (
      <aside className="terminal-panel profile-panel">
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
    <aside className="terminal-panel profile-panel">
      <div className="profile-head">
        <div className="avatar">{getInitials(trader.username ?? trader.pseudonym ?? trader.wallet)}</div>
        <div className="profile-title">
          <h2>{trader.username ?? trader.pseudonym ?? shortWallet(trader.wallet)}</h2>
          <p>{shortWallet(trader.wallet)}</p>
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
        <Metric
          label="Average placement"
          value={`${formatUsd(selectedTrader.summary.averagePlacement)} / trade`}
        />
        <div>
          <span className="metric-label">Last activity</span>
          <strong>
            <RelativeTime value={selectedTrader.summary.lastActivity} />
          </strong>
        </div>
        <Metric label="Data source" value={selectedTrader.dataSourceStatus} />
      </div>

      <section className="score-box">
        <div className="panel-head compact">
          <h3>Profile quality</h3>
          <strong>{formatScore(selectedTrader.summary.scores.overallScore)}</strong>
        </div>
        <p>Score analytique indicatif en lecture seule, pas un conseil financier.</p>
        <div className="score-grid">
          <Metric label="Indicative" value={formatScore(selectedTrader.summary.scores.indicativeScore)} />
          <Metric label="Activity" value={formatScore(selectedTrader.summary.scores.activityScore)} />
          <Metric label="Volume" value={formatScore(selectedTrader.summary.scores.volumeScore)} />
          <Metric label="Consistency" value={formatScore(selectedTrader.summary.scores.consistencyScore)} />
          <Metric label="Risk" value={`${selectedTrader.summary.scores.riskScore}/100`} />
        </div>
        <div className="risk-detail">
          <strong>{selectedTrader.summary.scores.riskLabel}</strong>
          <div>
            {selectedTrader.summary.scores.riskFactors.length === 0 ? <span>Risque indicatif calculé</span> : null}
            {selectedTrader.summary.scores.riskFactors.map((factor) => (
              <span key={factor}>{factor}</span>
            ))}
          </div>
        </div>
      </section>

      <h3>Top recent markets</h3>
      <div className="mini-list">
        {selectedTrader.marketsMostTraded.length === 0 ? <p>unavailable</p> : null}
        {selectedTrader.marketsMostTraded.slice(0, 5).map((market) => (
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
            {formatRelativeTime(trade.time)} | {trade.side ?? "unavailable"} | {trade.outcome ?? "unavailable"} |{" "}
            {formatUsd(trade.amount)}
          </span>
        ))}
      </div>
    </aside>
  );
}

function LiveTape({
  liveTrades,
  onClear,
  paused,
  setPaused,
}: {
  liveTrades: NormalizedTrade[];
  onClear: () => void;
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
        <button onClick={onClear} type="button">
          Clear
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
            <SourceBadge compact status={trade.dataSourceStatus} />
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreValue({ value }: { value: number | null }) {
  const scoreClass = value === null ? "unavailable" : value < 30 ? "low" : value < 60 ? "mid" : "high";

  return <span className={`score-value ${scoreClass}`}>{formatScore(value)}</span>;
}

function RelativeTime({ nowMs = Date.now(), value }: { nowMs?: number; value: string | null }) {
  return (
    <span className="single-line" title={formatFullLocalTime(value)}>
      {formatRelativeTime(value, nowMs)}
    </span>
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
      <MarketChart market={market} probabilities={getDisplayProbability(market, prices)} prices={prices} />
    </article>
  );
}

function MarketChart({
  compact = false,
  market,
  probabilities,
  prices,
  showSimulationOverlays = false,
  simulationPositions = [],
  targetPrice,
}: MarketChartProps) {
  if (isCryptoUpDownMarket(market)) {
    return (
      <CryptoPriceChart
        compact={compact}
        market={market}
        probabilities={probabilities}
        showSimulationOverlays={showSimulationOverlays}
        simulationPositions={showSimulationOverlays ? simulationPositions : []}
        targetPriceOverride={targetPrice}
      />
    );
  }

  return <ProbabilityHistoryChart market={market} prices={prices} />;
}

function CryptoPriceChart({
  compact = false,
  market,
  probabilities,
  showSimulationOverlays = false,
  simulationPositions = [],
  targetPriceOverride,
}: {
  compact?: boolean;
  market: PublicMarket;
  probabilities: BinaryMarketProbabilities;
  showSimulationOverlays?: boolean;
  simulationPositions?: SimulatedPosition[];
  targetPriceOverride?: number;
}) {
  const resolvedInitialTarget = useMemo(() => targetPriceOverride ?? resolvePolymarketTarget(market), [market, targetPriceOverride]);
  const [points, setPoints] = useState<CryptoChartPoint[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [targetPrice, setTargetPrice] = useState<number | null>(resolvedInitialTarget);
  const [targetSource, setTargetSource] = useState(resolvedInitialTarget === null ? "RTDS opening tick pending" : "Polymarket metadata");
  const [finalPrice, setFinalPrice] = useState<number | null>(market.finalPrice);
  const [status, setStatus] = useState<LiveStatus>("CONNECTING");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const symbols = useMemo(() => getCryptoSymbolsForMarket(market), [market.slug, market.question]);
  const lineColor = getCryptoLineColor(symbols.baseSymbol);
  const parsedMarketStartMs = market.eventStartTime === null ? NaN : Date.parse(market.eventStartTime);
  const parsedMarketEndMs = market.endDate === null ? NaN : Date.parse(market.endDate);
  const marketStartMs = Number.isNaN(parsedMarketStartMs) ? null : parsedMarketStartMs;
  const marketEndMs = Number.isNaN(parsedMarketEndMs) ? null : parsedMarketEndMs;
  const marketState = getCryptoMarketState({
    finalPrice,
    marketEndMs,
    marketStartMs,
    nowMs: Date.now(),
  });

  useEffect(() => {
    setPoints([]);
    setCurrentPrice(null);
    setTargetPrice(resolvedInitialTarget);
    setTargetSource(resolvedInitialTarget === null ? "RTDS opening tick pending" : "Polymarket metadata");
    setFinalPrice(market.finalPrice);
  }, [market.finalPrice, market.slug, resolvedInitialTarget]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({
      endTs: String(Math.floor((marketEndMs ?? Date.now()) / 1_000)),
      limit: "600",
      startTs: String(Math.floor((marketStartMs ?? Date.now() - 5 * 60_000) / 1_000)),
      symbol: symbols.chainlinkSymbol,
    });

    fetch(`/api/polymarket/crypto-prices/history?${query.toString()}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.json() as Promise<CryptoPriceHistoryResponse>;
      })
      .then((result) => {
        if (cancelled || result.points.length === 0) {
          return;
        }

        const hydratedPoints = result.points
          .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
          .map((point) => ({
            price: point.price,
            time: formatChartTime(Math.floor(point.timestamp / 1_000)),
            timestamp: Math.floor(point.timestamp / 1_000) * 1_000,
          }))
          .sort((left, right) => left.timestamp - right.timestamp);
        const latestPoint = hydratedPoints[hydratedPoints.length - 1];

        setPoints(hydratedPoints);
        if (latestPoint !== undefined && (marketEndMs === null || Date.now() < marketEndMs)) {
          setCurrentPrice(latestPoint.price);
        }
        setTargetPrice((existingTarget) => {
          if (existingTarget !== null || marketStartMs === null) {
            return existingTarget;
          }

          const firstPoint = hydratedPoints.find((point) => point.timestamp >= marketStartMs);
          if (firstPoint === undefined || firstPoint.timestamp - marketStartMs > 120_000) {
            return null;
          }

          setTargetSource("RTDS cached first available Chainlink tick after market start");
          return firstPoint.price;
        });
      })
      .catch(() => {
        // Live RTDS WebSocket remains the primary source; history is only an instant hydration helper.
      });

    return () => {
      cancelled = true;
    };
  }, [marketEndMs, marketStartMs, symbols.chainlinkSymbol]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (stopped) {
        return;
      }

      const query = new URLSearchParams({
        chainlinkSymbol: symbols.chainlinkSymbol,
        fallbackSymbol: symbols.fallbackSymbol,
      });
      socket = new WebSocket(buildWebSocketUrl(`/ws/crypto-prices?${query.toString()}`));
      setStatus("CONNECTING");

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (message === null) {
          return;
        }

        if (message.type === "status") {
          setStatus(message.status === "LIVE" ? "LIVE" : message.status === "CONNECTING" ? "CONNECTING" : "OFFLINE");
          setLatencyMs(readNumber(message.latencyMs));
          return;
        }

        const update = normalizeCryptoPriceUpdate(message);
        if (update === null) {
          return;
        }

        const updateTimestamp = update.upstreamTimestamp ?? Date.now();
        if (marketEndMs !== null && updateTimestamp >= marketEndMs) {
          if (update.source === "chainlink") {
            setFinalPrice((existingFinal) => existingFinal ?? update.price);
          }
          return;
        }

        if (marketEndMs !== null && Date.now() >= marketEndMs) {
          return;
        }

        if (marketStartMs !== null && updateTimestamp < marketStartMs) {
          return;
        }

        setStatus("LIVE");
        setLatencyMs(update.latencyMs);
        setCurrentPrice(update.price);
        setTargetPrice((existingTarget) => {
          if (existingTarget !== null) {
            return existingTarget;
          }

          if (marketStartMs === null || update.source !== "chainlink" || update.upstreamTimestamp === null) {
            return null;
          }

          const ageFromStartMs = update.upstreamTimestamp - marketStartMs;
          if (ageFromStartMs >= 0 && ageFromStartMs <= 120_000) {
            setTargetSource("RTDS first available Chainlink tick after market start");
            return update.price;
          }

          return null;
        });
        setPoints((current) => appendCryptoPoint(current, update, marketStartMs, marketEndMs));
      });

      socket.addEventListener("close", () => {
        if (!stopped) {
          setStatus("OFFLINE");
          reconnectTimer = window.setTimeout(connect, 1_000);
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
  }, [marketEndMs, marketStartMs, symbols.chainlinkSymbol, symbols.fallbackSymbol]);

  const displayedTargetPrice = marketState === "BEFORE_START" ? null : targetPrice;
  const displayedCurrentPrice = marketState === "BEFORE_START" ? null : marketState === "RESOLVED" ? finalPrice : currentPrice;
  const diff = displayedCurrentPrice !== null && displayedTargetPrice !== null ? displayedCurrentPrice - displayedTargetPrice : null;
  const outcome = finalPrice !== null && targetPrice !== null ? (finalPrice >= targetPrice ? "Up" : "Down") : null;
  const displaySymbol = symbols.chainlinkSymbol.toUpperCase();
  const currentDirection = useValueDirection(displayedCurrentPrice);
  const diffDirection = useValueDirection(diff);
  const formatCryptoValue = useCallback((value: number) => formatCryptoUsd(value, symbols.baseSymbol), [symbols.baseSymbol]);
  const formatSignedCryptoValue = useCallback((value: number) => formatSignedCryptoUsd(value, symbols.baseSymbol), [symbols.baseSymbol]);
  const yValues = points.map((point) => point.price);
  if (displayedTargetPrice !== null) {
    yValues.push(displayedTargetPrice);
  }
  if (displayedCurrentPrice !== null) {
    yValues.push(displayedCurrentPrice);
  }
  if (showSimulationOverlays) {
    for (const position of simulationPositions) {
      yValues.push(position.entryCryptoPrice);
      if (position.exitCryptoPrice !== undefined) {
        yValues.push(position.exitCryptoPrice);
      }
    }
  }
  const [minY, maxY] = getCryptoChartDomain(yValues, symbols.baseSymbol);
  const chartHeight = compact ? 170 : 320;
  const targetZone =
    displayedTargetPrice === null
      ? null
      : {
          buyNoMax: displayedTargetPrice * (1 - 2 / 10_000),
          buyYesMin: displayedTargetPrice * (1 + 2 / 10_000),
          neutralMax: displayedTargetPrice * (1 + 2 / 10_000),
          neutralMin: displayedTargetPrice * (1 - 2 / 10_000),
        };
  const targetDistanceLabel = diff === null || displayedTargetPrice === null ? null : formatTargetDistanceLabel(diff, displayedTargetPrice, symbols.baseSymbol);

  return (
    <div className={`crypto-market-chart move-${currentDirection}${compact ? " compact-chart-tile" : ""}`}>
      {compact ? (
        <>
          <div className="crypto-price-summary compact-summary">
            <AnimatedMetric fallback="Price To Beat en attente" formatter={formatCryptoValue} label="Price To Beat" value={displayedTargetPrice} />
            <AnimatedTimer endDate={market.endDate} state={marketState} />
          </div>
          <div className="compact-chart-toolbar">
            <span className={`target-state ${diff === null ? "" : diff >= 0 ? "above" : "below"}`}>
              {formatCryptoStateLabel(marketState, diff, outcome)}
            </span>
            {targetDistanceLabel !== null ? <small className="target-distance-chip">{targetDistanceLabel}</small> : null}
            <div className="readonly-outcome-strip compact-outcomes">
              <ProbabilityChip label="Up" value={probabilities.upProbability} />
              <ProbabilityChip label="Down" value={probabilities.downProbability} />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="crypto-price-summary">
            <AnimatedMetric fallback="Price To Beat en attente" formatter={formatCryptoValue} label="Price To Beat" value={displayedTargetPrice} />
            <AnimatedMetric fallback="En attente" formatter={formatCryptoValue} label={marketState === "RESOLVED" ? "Final Price" : "Current Price"} value={displayedCurrentPrice} />
            <AnimatedMetric className={`move-${diffDirection}`} fallback="Price To Beat en attente" formatter={formatSignedCryptoValue} label="Difference" value={diff} />
            <AnimatedTimer endDate={market.endDate} state={marketState} />
            <span className={`target-state ${diff === null ? "" : diff >= 0 ? "above" : "below"}`}>
              {formatCryptoStateLabel(marketState, diff, outcome)}
            </span>
            {DEBUG_UI ? <small>{status === "LIVE" ? `RTDS LIVE · ${formatLatency(latencyMs)}` : status}</small> : null}
            {DEBUG_UI ? <small>Target source: {targetSource}</small> : null}
          </div>

          <div className="readonly-outcome-strip">
            <ProbabilityChip label="Up" value={probabilities.upProbability} />
            <ProbabilityChip label="Down" value={probabilities.downProbability} />
          </div>
        </>
      )}

      <div className={`market-chart crypto-line-chart ${marketState === "RESOLVING" ? "is-resolving" : ""}`}>
        <div className="chart-head">
          <span>{displaySymbol} price</span>
          <div className="chart-head-actions">
            <span className={`chart-live-state ${status === "LIVE" ? "live" : ""}`}>{status === "LIVE" ? "LIVE" : "SNAPSHOT"}</span>
          </div>
        </div>
        {points.length === 0 ? (
          <p>{marketState === "BEFORE_START" ? "En attente du début du marché Chainlink." : "Waiting for Polymarket RTDS crypto price data."}</p>
        ) : (
          <ResponsiveContainer height={chartHeight} width="100%">
            <LineChart data={points} margin={{ bottom: 0, left: 4, right: 48, top: 8 }}>
              <CartesianGrid stroke="rgba(65, 78, 92, 0.35)" vertical={false} />
              <XAxis
                dataKey="timestamp"
                domain={["dataMin", "dataMax"]}
                minTickGap={28}
                stroke="#69798a"
                tick={{ fontSize: 10 }}
                tickFormatter={(value) => formatChartTime(Math.floor(Number(value) / 1_000))}
                type="number"
              />
              <YAxis
                domain={[minY, maxY]}
                orientation="right"
                stroke="#69798a"
                tick={{ fontSize: 10 }}
                tickFormatter={(value) => formatCryptoAxisUsd(Number(value), symbols.baseSymbol)}
                width={54}
              />
              <RechartsTooltip
                contentStyle={{ background: "#0d141c", border: "1px solid #2c3b4a", borderRadius: 8, color: "#e8edf4" }}
                formatter={(value) => [formatCryptoValue(Number(value)), displaySymbol]}
                labelFormatter={(value) => formatPreciseTime(Number(value))}
                labelStyle={{ color: "#92a4b8" }}
              />
              {targetZone !== null ? (
                <>
                  <ReferenceArea ifOverflow="extendDomain" y1={targetZone.buyYesMin} y2={maxY} fill="#24c68f" fillOpacity={0.045} />
                  <ReferenceArea ifOverflow="extendDomain" y1={minY} y2={targetZone.buyNoMax} fill="#ff5d6c" fillOpacity={0.045} />
                  <ReferenceArea
                    ifOverflow="extendDomain"
                    y1={targetZone.neutralMin}
                    y2={targetZone.neutralMax}
                    fill="#f0b35a"
                    fillOpacity={0.12}
                  />
                </>
              ) : null}
              {displayedTargetPrice !== null ? (
                <ReferenceLine
                  ifOverflow="extendDomain"
                  label={{ fill: "#f0b35a", fontSize: 11, position: "right", value: "Target" }}
                  stroke="#f0b35a"
                  strokeDasharray="5 5"
                  y={displayedTargetPrice}
                />
              ) : null}
              {displayedCurrentPrice !== null ? (
                <ReferenceLine
                  ifOverflow="extendDomain"
                  label={{ fill: "#64b7ff", fontSize: 11, position: "right", value: marketState === "RESOLVED" ? "Final" : "Current" }}
                  stroke="rgba(100, 183, 255, 0.28)"
                  strokeDasharray="2 6"
                  y={displayedCurrentPrice}
                />
              ) : null}
              {showSimulationOverlays ? (
                <PositionOverlay
                  maxY={maxY}
                  minY={minY}
                  positions={simulationPositions}
                  visibleEndTimestamp={points[points.length - 1]?.timestamp ?? Date.now()}
                />
              ) : null}
              <Line
                activeDot={{ r: 4 }}
                dataKey="price"
                dot={false}
                isAnimationActive={false}
                name={displaySymbol}
                stroke={lineColor}
                strokeWidth={2.6}
                type="linear"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {marketState === "RESOLVING" ? <div className="resolving-overlay">Market resolving</div> : null}
        {marketState === "RESOLVING" ? <p className="resolution-note">Résolution en cours</p> : null}
        {marketState === "RESOLVED" ? (
          <div className="resolution-note">
            Outcome {outcome ?? "en attente"} · <button onClick={() => window.location.reload()} type="button">Go to live market</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PositionOverlay({
  maxY,
  minY,
  positions,
  visibleEndTimestamp,
}: {
  maxY: number | "auto";
  minY: number | "auto";
  positions: SimulatedPosition[];
  visibleEndTimestamp: number;
}) {
  if (positions.length === 0 || typeof minY !== "number" || typeof maxY !== "number") {
    return null;
  }

  return (
    <>
      {positions.map((position) => {
        const entryX = Math.floor(position.entryTimestamp / 1_000) * 1_000;
        const exitX = Math.floor((position.exitTimestamp ?? visibleEndTimestamp) / 1_000) * 1_000;
        return (
          <ReferenceArea
            fill={position.side === "YES" ? "rgba(36, 230, 168, 0.08)" : "rgba(116, 139, 255, 0.08)"}
            ifOverflow="extendDomain"
            key={`area-${position.id}`}
            stroke="rgba(255,255,255,0.06)"
            strokeOpacity={0.7}
            x1={entryX}
            x2={Math.max(entryX, exitX)}
            y1={minY}
            y2={maxY}
          />
        );
      })}
      {positions.map((position) => {
        const entryX = Math.floor(position.entryTimestamp / 1_000) * 1_000;
        return (
          <ReferenceDot
            fill={position.side === "YES" ? "#24e6a8" : "#748bff"}
            ifOverflow="extendDomain"
            key={`entry-${position.id}`}
            label={{
              fill: position.side === "YES" ? "#79ffd3" : "#b4c0ff",
              fontSize: 10,
              position: "top",
              value: `BUY ${position.side}`,
            }}
            r={5}
            stroke="#071014"
            strokeWidth={2}
            x={entryX}
            y={position.entryCryptoPrice}
          />
        );
      })}
      {positions.map((position) => {
        if (position.exitTimestamp === undefined || position.exitCryptoPrice === undefined) {
          return null;
        }

        const isWin = (position.pnlUsd ?? 0) >= 0;
        const exitX = Math.floor(position.exitTimestamp / 1_000) * 1_000;
        return (
          <ReferenceDot
            fill={isWin ? "#55d98d" : "#ff5d6c"}
            ifOverflow="extendDomain"
            key={`exit-${position.id}`}
            label={{
              fill: isWin ? "#8dffbc" : "#ff9aa5",
              fontSize: 10,
              position: "bottom",
              value: `${isWin ? "WIN" : "LOSS"} ${formatSignedUsd(position.pnlUsd ?? 0)}`,
            }}
            r={5}
            stroke="#071014"
            strokeWidth={2}
            x={exitX}
            y={position.exitCryptoPrice}
          />
        );
      })}
      {positions.map((position) => {
        const entryX = Math.floor(position.entryTimestamp / 1_000) * 1_000;
        return (
          <ReferenceLine
            ifOverflow="extendDomain"
            key={`line-${position.id}`}
            stroke={position.side === "YES" ? "rgba(36,230,168,0.42)" : "rgba(116,139,255,0.42)"}
            strokeDasharray="3 7"
            x={entryX}
          />
        );
      })}
    </>
  );
}

function ProbabilityHistoryChart({ market, prices }: { market: PublicMarket; prices: Record<string, LivePrice> }) {
  const [data, setData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<ChartRangeKey>("6h");
  const tokenIds = useMemo(() => market.clobTokenIds.slice(0, 4), [market.clobTokenIds]);
  const rangeConfig =
    CHART_RANGES.find((item) => item.value === range) ?? {
      fidelity: 10,
      interval: "6h" as const,
      label: "6H",
      seconds: 6 * 60 * 60,
      value: "6h" as const,
    };
  const series = tokenIds.map((assetId, index) => ({
    assetId,
    color: CHART_COLORS[index % CHART_COLORS.length],
    label: market.outcomes[index] ?? `Outcome ${index + 1}`,
  }));
  const liveAssetsCount = tokenIds.filter((assetId) => prices[assetId] !== undefined).length;

  useEffect(() => {
    if (tokenIds.length === 0) {
      setData([]);
      return;
    }

    let stopped = false;
    const load = async () => {
      setLoading(true);
      try {
        const endTs = Math.floor(Date.now() / 1_000);
        const response = await fetch("/api/polymarket/batch-prices-history", {
          body: JSON.stringify({
            endTs,
            fidelity: rangeConfig.fidelity,
            interval: rangeConfig.interval,
            markets: tokenIds,
            startTs: Math.max(0, endTs - rangeConfig.seconds),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as PriceHistoryResponse;
        if (!stopped) {
          setData(buildChartData(payload.history ?? {}, tokenIds));
        }
      } catch {
        if (!stopped) {
          setData([]);
        }
      } finally {
        if (!stopped) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      stopped = true;
    };
  }, [rangeConfig.fidelity, rangeConfig.interval, rangeConfig.seconds, tokenIds]);

  useEffect(() => {
    const livePoint = buildLiveChartPoint(tokenIds, prices);
    if (livePoint === null) {
      return;
    }

    setData((current) => mergeLiveChartPoint(current, livePoint, tokenIds, rangeConfig.seconds));
  }, [prices, rangeConfig.seconds, tokenIds]);

  if (tokenIds.length === 0) {
    return null;
  }

  return (
    <div className="market-chart">
      <div className="chart-head">
        <span>Price history</span>
        <div className="chart-head-actions">
          <span className={`chart-live-state ${liveAssetsCount > 0 ? "live" : ""}`}>
            {liveAssetsCount > 0 ? "LIVE" : "SNAPSHOT"}
          </span>
          <div className="chart-range-pills" aria-label="Chart range">
            {CHART_RANGES.map((item) => (
              <button
                className={range === item.value ? "active" : ""}
                key={item.value}
                onClick={() => setRange(item.value)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
          <small>{loading ? "Loading" : rangeConfig.label}</small>
        </div>
      </div>
      {data.length === 0 ? (
        <p>No public chart data returned.</p>
      ) : (
        <ResponsiveContainer height={190} width="100%">
          <LineChart data={data} margin={{ bottom: 0, left: 2, right: 4, top: 8 }}>
            <CartesianGrid stroke="rgba(65, 78, 92, 0.35)" vertical={false} />
            <XAxis dataKey="time" minTickGap={28} stroke="#69798a" tick={{ fontSize: 10 }} />
            <YAxis
              domain={[0, 1]}
              orientation="right"
              stroke="#69798a"
              tick={{ fontSize: 10 }}
              tickFormatter={(value) => `${Math.round(Number(value) * 100)}%`}
              width={34}
            />
            <RechartsTooltip
              contentStyle={{ background: "#0d141c", border: "1px solid #2c3b4a", borderRadius: 8, color: "#e8edf4" }}
              formatter={(value, name) => [`${(Number(value) * 100).toFixed(1)}%`, name]}
              labelStyle={{ color: "#92a4b8" }}
            />
            {series.map((item) => (
              <Line
                activeDot={{ r: 3 }}
                connectNulls
                dataKey={item.assetId}
                dot={false}
                isAnimationActive={false}
                key={item.assetId}
                name={item.label}
                stroke={item.color}
                strokeWidth={2.2}
                type="stepAfter"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function AnimatedMetric({
  className = "",
  fallback,
  formatter,
  label,
  value,
}: {
  className?: string;
  fallback: string;
  formatter: (value: number) => string;
  label: string;
  value: number | null;
}) {
  return (
    <div className={`animated-metric ${className}`}>
      <span className="metric-label">{label}</span>
      <AnimatedValue fallback={fallback} formatter={formatter} tag="strong" value={value} />
    </div>
  );
}

function AnimatedTimer({ endDate, state }: { endDate: string | null; state: CryptoMarketState }) {
  const seconds = getTimeRemainingSeconds(endDate);
  const timerState =
    state === "RESOLVING" || state === "RESOLVED"
      ? "resolving"
      : seconds !== null && seconds <= 15
        ? "danger"
        : seconds !== null && seconds <= 60
          ? "warning"
          : "normal";
  const value = state === "RESOLVED" ? "Resolved" : state === "RESOLVING" ? "Resolving" : formatTimeRemaining(endDate);

  return (
    <div className={`animated-metric timer-metric ${timerState}`}>
      <span className="metric-label">Timer</span>
      <strong className="animated-value flat">
        {value}
      </strong>
    </div>
  );
}

function AnimatedValue({
  className = "",
  fallback = "En attente",
  formatter,
  tag = "span",
  value,
}: {
  className?: string;
  fallback?: string;
  formatter: (value: number) => string;
  tag?: "span" | "strong";
  value: number | null;
}) {
  const direction = useValueDirection(value);
  const displayValue = value === null || !Number.isFinite(value) ? fallback : formatter(value);
  const Element = tag;

  return (
    <Element className={`animated-value ${direction} ${className}`}>
      {displayValue}
    </Element>
  );
}

function ProbabilityChip({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={`probability-chip ${label.toLowerCase()}`}>
      {label} <AnimatedValue fallback="Waiting" formatter={formatPercent} value={value} />
    </span>
  );
}

function useValueDirection(value: number | null): ChangeDirection {
  const previous = useRef<number | null>(null);
  const [direction, setDirection] = useState<ChangeDirection>("flat");

  useEffect(() => {
    const nextDirection = getChangeDirection(previous.current, value);
    previous.current = value;
    setDirection(nextDirection);
  }, [value]);

  return direction;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SourceBadge({ compact = false, status }: { compact?: boolean; status: DataSourceStatus }) {
  const isReal = status === "REAL POLYMARKET DATA";
  const label = compact && isReal ? "REAL" : status;

  return (
    <span className={`source-badge ${isReal ? "real" : "unavailable"} ${compact ? "compact" : ""}`} title={status}>
      {label}
    </span>
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
    bestAsk: readNumber(message.bestAsk),
    bestBid: readNumber(message.bestBid),
    eventType: readString(message.eventType) ?? "price",
    latencyMs: readNumber(message.latencyMs),
    price: readNumber(message.price),
    time: readString(message.time) ?? new Date().toISOString(),
  };
}

function normalizeCryptoPriceUpdate(message: ServerMessage): CryptoPriceUpdate | null {
  const symbol = readString(message.symbol);
  const price = readNumber(message.price);
  const source = message.source === "chainlink" || message.source === "binance" ? message.source : null;
  if (symbol === null || price === null || source === null) {
    return null;
  }

  return {
    latencyMs: readNumber(message.latencyMs),
    price,
    source,
    symbol,
    time: readString(message.time) ?? new Date().toISOString(),
    type: "crypto_price",
    upstreamTimestamp: readNumber(message.upstreamTimestamp),
  };
}

function mergeTrades(incoming: NormalizedTrade[], current: NormalizedTrade[]) {
  const map = new Map<string, NormalizedTrade>();
  for (const trade of [...incoming, ...current]) {
    map.set(trade.id, trade);
  }

  return Array.from(map.values()).sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
}

function buildChartData(history: Record<string, Array<{ t: number; p: number }>>, tokenIds: string[]): ChartPoint[] {
  const points = new Map<number, ChartPoint>();

  for (const assetId of tokenIds) {
    for (const point of history[assetId] ?? []) {
      const current =
        points.get(point.t) ??
        ({
          t: point.t,
          time: formatChartTime(point.t),
        } as ChartPoint);
      current[assetId] = point.p;
      points.set(point.t, current);
    }
  }

  return Array.from(points.values()).sort((left, right) => left.t - right.t);
}

function buildLiveChartPoint(tokenIds: string[], prices: Record<string, LivePrice>): ChartPoint | null {
  const values: Array<[string, number]> = [];
  let latestMs = 0;

  for (const assetId of tokenIds) {
    const livePrice = prices[assetId];
    if (livePrice === undefined) {
      continue;
    }

    const price = livePrice.price ?? calculateMidpoint(livePrice.bestBid, livePrice.bestAsk);
    if (price === null || !Number.isFinite(price)) {
      continue;
    }

    const parsedTime = Date.parse(livePrice.time);
    latestMs = Math.max(latestMs, Number.isNaN(parsedTime) ? Date.now() : parsedTime);
    values.push([assetId, Math.max(0, Math.min(1, price))]);
  }

  if (values.length === 0) {
    return null;
  }

  const t = Math.floor(Math.floor(latestMs / 1_000) / 5) * 5;
  const point = {
    t,
    time: formatChartTime(t),
  } as ChartPoint;

  for (const [assetId, price] of values) {
    point[assetId] = price;
  }

  return point;
}

function mergeLiveChartPoint(current: ChartPoint[], incoming: ChartPoint, tokenIds: string[], rangeSeconds: number) {
  const map = new Map<number, ChartPoint>();
  for (const point of current) {
    map.set(point.t, { ...point });
  }

  const previous = current.length > 0 ? current[current.length - 1] : undefined;
  const merged =
    map.get(incoming.t) ??
    ({
      t: incoming.t,
      time: formatChartTime(incoming.t),
    } as ChartPoint);

  for (const assetId of tokenIds) {
    const incomingValue = readChartNumber(incoming[assetId]);
    const previousValue = previous === undefined ? null : readChartNumber(previous[assetId]);
    const currentValue = readChartNumber(merged[assetId]);
    if (incomingValue !== null) {
      merged[assetId] = incomingValue;
    } else if (currentValue === null && previousValue !== null) {
      merged[assetId] = previousValue;
    }
  }

  map.set(incoming.t, merged);

  const cutoff = Math.floor(Date.now() / 1_000) - rangeSeconds;
  return Array.from(map.values())
    .filter((point) => point.t >= cutoff)
    .sort((left, right) => left.t - right.t)
    .slice(-600);
}

function readChartNumber(value: number | string | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function appendCryptoPoint(
  current: CryptoChartPoint[],
  update: CryptoPriceUpdate,
  marketStartMs: number | null,
  marketEndMs: number | null,
) {
  const timestamp = update.upstreamTimestamp ?? Date.now();
  const floorTimestamp = Math.floor(timestamp / 1_000) * 1_000;
  const lowerBound = marketStartMs ?? Date.now() - 6 * 60 * 60 * 1_000;
  const upperBound = marketEndMs ?? Date.now() + 60 * 60 * 1_000;

  const point = {
    price: update.price,
    time: formatChartTime(Math.floor(floorTimestamp / 1_000)),
    timestamp: floorTimestamp,
  };
  const withoutDuplicate = current.filter((item) => item.timestamp !== point.timestamp);
  return [...withoutDuplicate, point]
    .filter((item) => item.timestamp >= lowerBound && item.timestamp <= upperBound + 5_000)
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-600);
}

function getCryptoMarketState({
  finalPrice,
  marketEndMs,
  marketStartMs,
  nowMs,
}: {
  finalPrice: number | null;
  marketEndMs: number | null;
  marketStartMs: number | null;
  nowMs: number;
}): CryptoMarketState {
  if (marketStartMs !== null && nowMs < marketStartMs) {
    return "BEFORE_START";
  }

  if (marketEndMs !== null && nowMs >= marketEndMs) {
    return finalPrice === null ? "RESOLVING" : "RESOLVED";
  }

  return "LIVE";
}

function formatCryptoStateLabel(state: CryptoMarketState, diff: number | null, outcome: string | null) {
  if (state === "BEFORE_START") {
    return "Target en attente";
  }

  if (state === "RESOLVING") {
    return "Résolution en cours";
  }

  if (state === "RESOLVED") {
    return outcome === null ? "Outcome en attente" : `Outcome ${outcome}`;
  }

  if (diff === null) {
    return "Chainlink delayed";
  }

  return diff >= 0 ? "Above Target" : "Below Target";
}

function isCryptoUpDownMarket(market: PublicMarket) {
  const slug = market.slug?.toLowerCase() ?? "";
  const title = market.question?.toLowerCase() ?? "";
  return (
    market.sourceType === "CURATED_LIVE_CRYPTO" ||
    slug.includes("updown") ||
    title.includes("up or down")
  );
}

function getCryptoSymbolsForMarket(market: PublicMarket) {
  const text = `${market.slug ?? ""} ${market.question ?? ""}`.toLowerCase();
  if (text.includes("doge") || text.includes("dogecoin")) {
    return { baseSymbol: "doge", chainlinkSymbol: "doge/usd", fallbackSymbol: "dogeusdt" };
  }
  if (text.includes("hype") || text.includes("hyperliquid")) {
    return { baseSymbol: "hype", chainlinkSymbol: "hype/usd", fallbackSymbol: "hypeusdt" };
  }
  if (text.includes("bnb")) {
    return { baseSymbol: "bnb", chainlinkSymbol: "bnb/usd", fallbackSymbol: "bnbusdt" };
  }
  if (text.includes("eth")) {
    return { baseSymbol: "eth", chainlinkSymbol: "eth/usd", fallbackSymbol: "ethusdt" };
  }
  if (text.includes("sol")) {
    return { baseSymbol: "sol", chainlinkSymbol: "sol/usd", fallbackSymbol: "solusdt" };
  }
  if (text.includes("xrp")) {
    return { baseSymbol: "xrp", chainlinkSymbol: "xrp/usd", fallbackSymbol: "xrpusdt" };
  }
  return { baseSymbol: "btc", chainlinkSymbol: "btc/usd", fallbackSymbol: "btcusdt" };
}

function getCryptoChartDomain(values: number[], symbol: string): [number | "auto", number | "auto"] {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return ["auto", "auto"];
  }

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const midpoint = (min + max) / 2 || min || 1;
  const rawSpan = Math.max(0, max - min);
  const minSpan = getCryptoMinVisibleSpan(symbol, midpoint);
  const visualSpan = Math.max(rawSpan * 1.28, minSpan);
  const lower = Math.max(0, midpoint - visualSpan / 2);
  const upper = midpoint + visualSpan / 2;

  return [lower, upper];
}

function getCryptoMinVisibleSpan(symbol: string, price: number) {
  const relativeSpan = Math.abs(price) * 0.00018;
  const absoluteMinimums: Record<string, number> = {
    bnb: 0.08,
    btc: 8,
    doge: 0.000035,
    eth: 0.28,
    hype: 0.006,
    sol: 0.018,
    xrp: 0.0003,
  };

  return Math.max(relativeSpan, absoluteMinimums[symbol] ?? 0.01);
}

function getCryptoLineColor(symbol: string) {
  switch (symbol) {
    case "btc":
      return "#f7931a";
    case "eth":
      return "#627eea";
    case "sol":
      return "#14f195";
    case "xrp":
      return "#d8e1ea";
    case "doge":
      return "#c2a633";
    case "hype":
      return "#24e6a8";
    case "bnb":
      return "#f3ba2f";
    default:
      return "#f2a23a";
  }
}

function routeFromPath(pathname: string): RouteKey {
  if (pathname.startsWith("/opening-scenario-bot")) {
    return "opening-scenario-bot";
  }
  if (pathname.startsWith("/simulation-bot")) {
    return "simulation-bot";
  }
  if (pathname.startsWith("/top-traders")) {
    return "top-traders";
  }
  if (pathname.startsWith("/settings")) {
    return "settings";
  }
  return "markets";
}

function pathForRoute(route: RouteKey) {
  if (route === "opening-scenario-bot") return "/opening-scenario-bot";
  if (route === "simulation-bot") return "/simulation-bot";
  if (route === "top-traders") return "/top-traders";
  if (route === "settings") return "/settings";
  return "/markets";
}

const simulationStorage = {
  getBots(): BotConfig[] {
    return readSimulationStorage().bots;
  },
  getDecisions(): BotDecision[] {
    return readSimulationStorage().decisions;
  },
  getFills(): PaperFill[] {
    return readSimulationStorage().fills;
  },
  getOrders(): PaperOrder[] {
    return readSimulationStorage().orders;
  },
  getPositions(): SimulatedPosition[] {
    return readSimulationStorage().positions;
  },
  getSessions(): SimulationSession[] {
    return readSimulationStorage().sessions;
  },
  save(state: {
    bots: BotConfig[];
    decisions: BotDecision[];
    fills: PaperFill[];
    orders: PaperOrder[];
    positions: SimulatedPosition[];
    sessions: SimulationSession[];
  }) {
    try {
      window.localStorage.setItem(SIMULATION_STORAGE_KEY, JSON.stringify(pruneSimulationStorageState(state, SIMULATION_STORAGE_LIMITS)));
    } catch (error) {
      try {
        window.localStorage.setItem(
          SIMULATION_STORAGE_KEY,
          JSON.stringify(pruneSimulationStorageState(state, SIMULATION_STORAGE_COMPACT_LIMITS, true)),
        );
      } catch (secondError) {
        try {
          window.localStorage.removeItem(SIMULATION_STORAGE_KEY);
          window.localStorage.setItem(
            SIMULATION_STORAGE_KEY,
            JSON.stringify(
              pruneSimulationStorageState(
                {
                  ...state,
                  decisions: [],
                  fills: [],
                  orders: [],
                  positions: [],
                  sessions: state.sessions.slice(0, 5),
                },
                SIMULATION_STORAGE_COMPACT_LIMITS,
                true,
              ),
            ),
          );
        } catch {
          console.warn("BLACK-GOAT simulation storage quota exceeded; in-memory state kept only.", error, secondError);
        }
      }
    }
  },
};

function readSimulationStorage() {
  const fallback = {
    bots: [] as BotConfig[],
    decisions: [] as BotDecision[],
    fills: [] as PaperFill[],
    orders: [] as PaperOrder[],
    positions: [] as SimulatedPosition[],
    sessions: [] as SimulationSession[],
  };
  try {
    const raw = window.localStorage.getItem(SIMULATION_STORAGE_KEY);
    if (raw === null) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    return pruneSimulationStorageState({
      bots: Array.isArray(parsed.bots) ? parsed.bots.filter(isBotConfig) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter(isBotDecision) : [],
      fills: Array.isArray(parsed.fills) ? parsed.fills.filter(isPaperFill) : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders.filter(isPaperOrder) : [],
      positions: Array.isArray(parsed.positions) ? parsed.positions.filter(isSimulatedPosition) : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSimulationSession) : [],
    }, SIMULATION_STORAGE_LIMITS);
  } catch {
    return fallback;
  }
}

function pruneSimulationStorageState(
  state: {
    bots: BotConfig[];
    decisions: BotDecision[];
    fills: PaperFill[];
    orders: PaperOrder[];
    positions: SimulatedPosition[];
    sessions: SimulationSession[];
  },
  limits: typeof SIMULATION_STORAGE_LIMITS,
  compact = false,
) {
  return {
    bots: state.bots.slice(0, limits.bots),
    decisions: state.decisions.slice(0, limits.decisions).map((decision) => (compact ? compactDecisionForStorage(decision) : decision)),
    fills: state.fills.slice(0, limits.fills),
    orders: state.orders.slice(0, limits.orders).map((order) =>
      compact
        ? {
            ...order,
            reasons: order.reasons.slice(0, 5),
          }
        : order,
    ),
    positions: state.positions.slice(0, limits.positions).map((position) =>
      compact
        ? {
            ...position,
            decisionReasons: position.decisionReasons.slice(0, 5),
          }
        : position,
    ),
    sessions: state.sessions.slice(0, limits.sessions).map((session) =>
      compact
        ? {
            ...session,
            notes: session.notes.slice(0, 5),
          }
        : session,
    ),
  };
}

function compactDecisionForStorage(decision: BotDecision): BotDecision {
  const diagnostics = decision.diagnostics;
  return {
    ...decision,
    blockedBy: decision.blockedBy.slice(0, 12),
    reasons: decision.reasons.slice(0, 12),
    diagnostics:
      diagnostics === undefined
        ? undefined
        : {
            ...diagnostics,
            deRisk: diagnostics.deRisk,
            entryOpportunity: diagnostics.entryOpportunity,
            finalSettlement:
              diagnostics.finalSettlement === undefined
                ? undefined
                : {
                    ...diagnostics.finalSettlement,
                    reasonCodes: diagnostics.finalSettlement.reasonCodes.slice(0, 8),
                  },
            forcedPaperPick: diagnostics.forcedPaperPick,
            mandatoryDecision:
              diagnostics.mandatoryDecision === undefined
                ? undefined
                : {
                    ...diagnostics.mandatoryDecision,
                    reasonCodes: diagnostics.mandatoryDecision.reasonCodes.slice(0, 10),
                  },
            openingEntry: diagnostics.openingEntry,
            openingScenario:
              diagnostics.openingScenario === undefined
                ? undefined
                : {
                    ...diagnostics.openingScenario,
                    scenarios: diagnostics.openingScenario.scenarios.map((scenario) => ({
                      ...scenario,
                      reasonCodes: scenario.reasonCodes.slice(0, 8),
                    })),
                  },
            openingSettings: undefined,
            smartScaling: diagnostics.smartScaling,
          },
  };
}

function createBotFormState(profile: BotRiskProfile): BotFormState {
  const preset = BOT_PRESETS[profile];
  return {
    allowedAssets: [...BOT_ASSETS],
    fillModel: preset.fillModel,
    maxDailyRiskPercent: String(preset.maxDailyRiskPercent),
    maxOpenPositions: String(preset.maxOpenPositions),
    maxSpreadPercent: String(preset.maxSpreadPercent),
    maxTimeToExpirySeconds: String(preset.maxTimeToExpirySeconds),
    maxTradesPerDay: String(preset.maxTradesPerDay),
    minEdgePercent: String(preset.minEdgePercent),
    minLiquidityScore: String(preset.minLiquidityScore),
    minTimeToExpirySeconds: String(preset.minTimeToExpirySeconds),
    modelMode: "rules",
    name: `${BOT_PROFILE_LABELS[profile]} Bot`,
    profile,
    riskPercentPerTrade: String(preset.riskPercentPerTrade),
    startingBalance: profile === "opening_scenario_bot" ? "50" : "1000",
  };
}

function createBotFromForm(form: BotFormState): BotConfig {
  const startingBalance = readFormNumber(form.startingBalance, 1000);
  return {
    advancedRules: createNormalBotV2Rules(),
    allowedAssets: form.allowedAssets.length === 0 ? ["BTC"] : form.allowedAssets,
    createdAt: Date.now(),
    currentBalance: startingBalance,
    fillModel: form.fillModel,
    id: makeId("bot"),
    maxDailyRiskPercent: readFormNumber(form.maxDailyRiskPercent, 2),
    maxOpenPositions: Math.max(1, Math.round(readFormNumber(form.maxOpenPositions, 1))),
    maxSpreadPercent: readFormNumber(form.maxSpreadPercent, 4),
    maxTimeToExpirySeconds: Math.round(readFormNumber(form.maxTimeToExpirySeconds, 240)),
    maxTradesPerDay: Math.max(1, Math.round(readFormNumber(form.maxTradesPerDay, 10))),
    minEdgePercent: readFormNumber(form.minEdgePercent, 5),
    minLiquidityScore: readFormNumber(form.minLiquidityScore, 60),
    minTimeToExpirySeconds: Math.round(readFormNumber(form.minTimeToExpirySeconds, 60)),
    modelMode: form.modelMode,
    name: form.name.trim().length === 0 ? "Simulation Bot" : form.name.trim(),
    profile: form.profile,
    riskPercentPerTrade: readFormNumber(form.riskPercentPerTrade, 0.5),
    startingBalance,
    status: "paused",
  };
}

function createNormalBotV2Rules(): BotAdvancedRules {
  return JSON.parse(JSON.stringify(NORMAL_BOT_V2_RULES)) as BotAdvancedRules;
}

function getBotRules(bot: BotConfig): BotAdvancedRules {
  void bot;
  return NORMAL_BOT_V2_RULES;
}

function createSimulationSession(bot: BotConfig, market: PublicMarket | null): SimulationSession {
  const asset = market === null ? null : getBotAssetForMarket(market);
  return {
    id: makeId("session"),
    assets: asset === null ? [] : [asset],
    botId: bot.id,
    botName: bot.name,
    marketIds: market === null ? [] : [getMarketKey(market)],
    notes: ["paper trading session", "read-only public Polymarket data"],
    startedAt: Date.now(),
    startingBalance: bot.currentBalance,
    status: "running",
  };
}

function touchSimulationSession(session: SimulationSession, market: PublicMarket, asset: BotAsset, currentBalance: number): SimulationSession {
  return {
    ...session,
    assets: Array.from(new Set([...session.assets, asset])),
    botName: session.botName,
    endingBalance: currentBalance,
    marketIds: Array.from(new Set([...session.marketIds, getMarketKey(market)])),
    status: "running",
  };
}

function upsertSimulationSession(sessions: SimulationSession[], nextSession: SimulationSession) {
  const exists = sessions.some((session) => session.id === nextSession.id);
  if (!exists) {
    return [nextSession, ...sessions].slice(0, 120);
  }
  return sessions.map((session) => (session.id === nextSession.id ? nextSession : session));
}

function getAssignedBotMarkets(markets: PublicMarket[], bot: BotConfig | null) {
  if (bot === null) {
    return [];
  }

  const allowed = new Set<BotAsset>(getRuntimeBotAssets(bot));
  return BOT_ASSETS.map((asset) => (allowed.has(asset) ? getPreferredMarketForAsset(markets, asset, Date.now()) : null)).filter(
    (market): market is PublicMarket => market !== null,
  );
}

function getRuntimeBotAssets(bot: BotConfig) {
  void bot;
  return BOT_ASSETS;
}

function getSimulationChartMarkets(markets: PublicMarket[], bot: BotConfig | null, activeAsset: BotAsset, limit: number, nowMs: number) {
  const assetOrder: BotAsset[] = [];
  const pushAsset = (asset: BotAsset) => {
    if (!assetOrder.includes(asset)) {
      assetOrder.push(asset);
    }
  };

  pushAsset(activeAsset);
  for (const asset of bot?.allowedAssets ?? BOT_ASSETS) {
    pushAsset(asset);
  }
  for (const asset of BOT_ASSETS) {
    pushAsset(asset);
  }

  return assetOrder
    .map((asset) => getPreferredMarketForAsset(markets, asset, nowMs))
    .filter((market): market is PublicMarket => market !== null)
    .slice(0, limit);
}

function getPreferredMarketForAsset(markets: PublicMarket[], asset: BotAsset, nowMs: number) {
  return (
    markets
      .filter((market) => getBotAssetForMarket(market) === asset)
      .sort((left, right) => getMarketDisplayRank(left, nowMs) - getMarketDisplayRank(right, nowMs))[0] ?? null
  );
}

function getMarketDisplayRank(market: PublicMarket, nowMs: number) {
  const startMs = market.eventStartTime === null ? Number.NaN : Date.parse(market.eventStartTime);
  const endMs = market.endDate === null ? Number.NaN : Date.parse(market.endDate);
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);

  if (hasStart && hasEnd && startMs <= nowMs && nowMs < endMs) {
    return Math.max(0, endMs - nowMs);
  }
  if (hasStart && startMs > nowMs) {
    return 10_000_000_000 + (startMs - nowMs);
  }
  if (hasEnd) {
    return 20_000_000_000 + Math.abs(nowMs - endMs);
  }

  return 30_000_000_000;
}

function dedupeMarkets(markets: Array<PublicMarket | null>) {
  const seen = new Set<string>();
  const result: PublicMarket[] = [];
  for (const market of markets) {
    if (market === null) {
      continue;
    }
    const key = getMarketKey(market);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(market);
  }
  return result;
}

function getBotAssetForMarket(market: PublicMarket): BotAsset | null {
  const label = inferCryptoChartLabel(market);
  return isBotAsset(label) ? label : null;
}

function isBotAsset(value: string): value is BotAsset {
  return (BOT_ASSETS as string[]).includes(value);
}

function getMarketKey(market: PublicMarket) {
  return market.id ?? market.slug ?? market.question ?? "market";
}

function calculateSpreadPercent(bestBid: number | null, bestAsk: number | null) {
  if (bestBid === null || bestAsk === null || bestAsk <= 0) {
    return 4;
  }
  return Math.max(0, ((bestAsk - bestBid) / bestAsk) * 100);
}

function calculateLiquidityScore(liquidity: number | null) {
  if (liquidity === null || !Number.isFinite(liquidity)) {
    return 50;
  }
  return Math.max(10, Math.min(100, Math.round(Math.log10(Math.max(10, liquidity)) * 22)));
}

function calculatePriceVelocity(points: CryptoChartPoint[]) {
  if (points.length < 2) {
    return 0;
  }
  const latest = points[points.length - 1];
  const previous = points[Math.max(0, points.length - 10)];
  if (latest === undefined || previous === undefined || previous.price <= 0) {
    return 0;
  }
  return (latest.price - previous.price) / previous.price;
}

function estimateRecentVolatility(points: CryptoChartPoint[]) {
  if (points.length < 4) {
    return 0.001;
  }
  const recent = points.slice(-24);
  const returns = recent.slice(1).map((point, index) => {
    const previous = recent[index];
    return previous === undefined || previous.price <= 0 ? 0 : Math.abs((point.price - previous.price) / previous.price);
  });
  return returns.reduce((total, value) => total + value, 0) / Math.max(returns.length, 1);
}

function buildEquityValues(startingBalance: number, positions: SimulatedPosition[]) {
  const values = [startingBalance];
  for (const position of [...positions].sort((left, right) => (left.exitTimestamp ?? left.entryTimestamp) - (right.exitTimestamp ?? right.entryTimestamp))) {
    values.push((values[values.length - 1] ?? startingBalance) + (position.pnlUsd ?? 0));
  }
  return values;
}

function calculateMaxDrawdown(values: number[]) {
  let peak = values[0] ?? 0;
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - value) / peak) * 100);
    }
  }
  return maxDrawdown;
}

function countConsecutiveLosses(positions: SimulatedPosition[]) {
  let count = 0;
  for (const position of [...positions].sort((left, right) => (right.exitTimestamp ?? right.entryTimestamp) - (left.exitTimestamp ?? left.entryTimestamp))) {
    if ((position.pnlUsd ?? 0) < 0) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function clampProbability(value: number) {
  return Math.max(0.01, Math.min(0.99, value));
}

function readFormNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSameUtcDay(left: number, right: number) {
  return new Date(left).toISOString().slice(0, 10) === new Date(right).toISOString().slice(0, 10);
}

function isBotConfig(value: unknown): value is BotConfig {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isBotDecision(value: unknown): value is BotDecision {
  return isRecord(value) && typeof value.id === "string" && typeof value.botId === "string";
}

function isSimulatedPosition(value: unknown): value is SimulatedPosition {
  return isRecord(value) && typeof value.id === "string" && typeof value.botId === "string";
}

function isSimulationSession(value: unknown): value is SimulationSession {
  return isRecord(value) && typeof value.id === "string" && typeof value.botId === "string";
}

function isPaperOrder(value: unknown): value is PaperOrder {
  return isRecord(value) && typeof value.id === "string" && typeof value.botId === "string" && value.type === "paper_order";
}

function isPaperFill(value: unknown): value is PaperFill {
  return isRecord(value) && typeof value.id === "string" && typeof value.botId === "string" && value.type === "paper_fill";
}

function buildSimulationExportPayload({
  bot,
  decisions,
  fills,
  orders,
  positions,
  sessions,
  stats,
}: {
  bot: BotConfig;
  decisions: BotDecision[];
  fills: PaperFill[];
  orders: PaperOrder[];
  positions: SimulatedPosition[];
  sessions: SimulationSession[];
  stats: BotPerformanceStats | null;
}) {
  return {
    appName: "BLACK-GOAT",
    exportType: "paper_trading_analysis",
    exportedAt: new Date().toISOString(),
    readOnly: true,
    disclaimer: "Données de simulation locale uniquement. Aucun ordre réel Polymarket n'a été placé.",
    bot,
    blackGoatV3Config: BLACK_GOAT_V3_CONFIG,
    normalBotV2Rules: getBotRules(bot),
    liveReadinessRules: {
      maxDrawdownPercent: 6,
      minCalibrationScore: 0.7,
      minDaysTested: 14,
      minPaperTrades: 300,
      minProfitFactor: 1.2,
      minResolvedMarkets: 100,
      minWinRate: 45,
      requirePositivePnlAcrossAssets: false,
      requirePositivePnlOnPrimaryAsset: true,
    },
    decisionLoggingFields: [
      "timeToExpirySeconds",
      "marketPhase",
      "cryptoPrice",
      "targetPrice",
      "distanceToTargetPercent",
      "distanceToTargetBps",
      "volatility1m",
      "volatility5m",
      "volumeSpikeScore",
      "cvdScore",
      "orderbookImbalanceCrypto",
      "orderbookImbalancePolymarket",
      "spreadPercent",
      "liquidityScore",
      "slippageEstimatePercent",
      "modelVersion",
      "strategyMode",
      "signalScore",
      "contradictionScore",
      "agreementCount",
      "regime",
      "dataAgeMs",
      "latencyMs",
      "targetComparator.targetState",
      "targetComparator.tradeableSide",
      "targetComparator.cushionScore",
      "targetComparator.reversalRisk",
      "targetComparator.requiredMoveToFlipTarget",
      "targetComparator.volatilityAdjustedDistance",
      "targetComparator.atrCushionRatio",
      "finalSettlement.forecast",
      "finalSettlement.probabilityFinalAbove",
      "finalSettlement.probabilityFinalBelow",
      "entryOpportunity.edgeYesNet",
      "entryOpportunity.edgeNoNet",
      "forcedPaperPick.side",
      "mandatoryDecision.status",
      "openingScenario.scenarioA",
      "openingScenario.scenarioB",
      "openingScenario.scenarioC",
      "openingScenario.primaryScenario",
      "openingEntry.action",
      "opening_near_target_override_used",
      "legacy_signal_score_ignored",
      "pre_open_bias_score",
      "pre_open_bias_direction",
      "primary_scenario_kept_despite_no_trade",
      "forced_min_stake_paper_used",
      "late_forced_entry_used",
      "smartScaling.action",
      "deRisk.action",
    ],
    stats,
    sessions,
    paper_orders: orders,
    paper_fills: fills,
    paper_positions: positions,
    paper_decisions: decisions,
  };
}

function positionsToCsv(
  positions: SimulatedPosition[],
  decisions: BotDecision[],
  orders: PaperOrder[],
  fills: PaperFill[],
) {
  const rows = [
    [
      "position_id",
      "session_id",
      "bot_id",
      "market_id",
      "asset",
      "side",
      "status",
      "entry_time",
      "exit_time",
      "entry_crypto_price",
      "exit_crypto_price",
      "entry_token_price",
      "exit_token_price",
      "size_usd",
      "pnl_usd",
      "pnl_percent",
      "edge_at_entry",
      "model_probability_at_entry",
      "order_id",
      "fill_id",
      "decision_count_session",
      "order_status",
      "fill_model",
      "reasons",
    ],
    ...positions.map((position) => {
      const order = orders.find((item) => item.id === position.orderId);
      const fill = fills.find((item) => item.id === position.fillId);
      const sessionDecisionCount = decisions.filter((decision) => decision.sessionId === position.sessionId).length;
      return [
        position.id,
        position.sessionId ?? "",
        position.botId,
        position.marketId,
        position.asset,
        position.side,
        position.status,
        new Date(position.entryTimestamp).toISOString(),
        position.exitTimestamp === undefined ? "" : new Date(position.exitTimestamp).toISOString(),
        String(position.entryCryptoPrice),
        position.exitCryptoPrice === undefined ? "" : String(position.exitCryptoPrice),
        String(position.entryTokenPrice),
        position.exitTokenPrice === undefined ? "" : String(position.exitTokenPrice),
        String(position.entrySizeUsd),
        position.pnlUsd === undefined ? "" : String(position.pnlUsd),
        position.pnlPercent === undefined ? "" : String(position.pnlPercent),
        String(position.edgeAtEntry),
        String(position.modelProbabilityAtEntry),
        position.orderId ?? "",
        position.fillId ?? "",
        String(sessionDecisionCount),
        order?.status ?? "",
        fill?.fillModel ?? "",
        position.decisionReasons.join(" | "),
      ];
    }),
  ];

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function decisionsToCsv(decisions: BotDecision[]) {
  const rows = [
    [
      "decision_id",
      "session_id",
      "bot_id",
      "market_id",
      "asset",
      "timestamp",
      "decision",
      "edge_yes",
      "edge_no",
      "edge_net",
      "confidence",
      "ask_yes",
      "ask_no",
      "position_size",
      "time_to_expiry",
      "market_phase",
      "crypto_price",
      "target_price",
      "distance_bps",
      "volatility_1m",
      "volatility_5m",
      "spread_percent",
      "liquidity_score",
      "slippage_percent",
      "signal_score",
      "contradiction_score",
      "agreement_count",
      "regime",
      "data_age_ms",
      "latency_ms",
      "target_state",
      "tradeable_side",
      "cushion_score",
      "reversal_risk",
      "required_move_to_flip_target",
      "volatility_adjusted_distance",
      "atr_cushion_ratio",
      "current_position_relative_to_target",
      "probability_final_above",
      "probability_final_below",
      "forecast",
      "forecast_confidence",
      "yes_bid",
      "no_bid",
      "edge_yes_raw",
      "edge_no_raw",
      "edge_yes_net",
      "edge_no_net",
      "best_side",
      "forced_paper_pick_side",
      "forced_paper_pick_confidence",
      "forced_paper_pick_reason",
      "decision_status",
      "entry_mode",
      "starter_entry_approved",
      "starter_size_usd",
      "opening_bot_enabled",
      "opening_entry_mode",
      "opening_entry_action",
      "opening_target_price",
      "opening_crypto_price",
      "opening_distance_to_target_usd",
      "opening_distance_to_target_bps",
      "scenario_a_label",
      "scenario_a_side",
      "scenario_a_probability",
      "scenario_a_confidence",
      "scenario_a_entry_plan",
      "scenario_a_max_acceptable_ask",
      "scenario_a_invalidation",
      "scenario_a_reason_codes",
      "scenario_b_label",
      "scenario_b_side",
      "scenario_b_probability",
      "scenario_b_confidence",
      "scenario_b_entry_plan",
      "scenario_b_max_acceptable_ask",
      "scenario_b_invalidation",
      "scenario_b_reason_codes",
      "scenario_c_label",
      "scenario_c_side",
      "scenario_c_probability",
      "scenario_c_confidence",
      "scenario_c_entry_plan",
      "scenario_c_reason_codes",
      "primary_scenario_label",
      "primary_scenario_side",
      "primary_scenario_probability",
      "primary_scenario_confidence",
      "opening_decision",
      "opening_decision_reason",
      "opening_entry_price",
      "opening_entry_size_usd",
      "opening_blocked_reason",
      "opening_near_target_override_used",
      "legacy_signal_score_ignored",
      "pre_open_bias_score",
      "pre_open_bias_direction",
      "primary_scenario_kept_despite_no_trade",
      "forced_min_stake_paper_used",
      "late_forced_entry_used",
      "smart_scaling_action",
      "add_count",
      "average_entry_price",
      "current_position_size_usd",
      "de_risk_action",
      "blocked_reason",
      "reason_codes",
      "explanation",
      "model_version",
      "strategy_version",
      "blocked_by",
      "reasons",
    ],
    ...decisions.map((decision) => {
      const diagnostics = decision.diagnostics;
      const comparator = diagnostics?.targetComparator;
      const forecast = diagnostics?.finalSettlement;
      const opportunity = diagnostics?.entryOpportunity;
      const forcedPick = diagnostics?.forcedPaperPick;
      const mandatory = diagnostics?.mandatoryDecision;
      const openingScenario = diagnostics?.openingScenario;
      const openingEntry = diagnostics?.openingEntry;
      const openingSettings = diagnostics?.openingSettings;
      const scenarioA = openingScenario?.scenarios.find((scenario) => scenario.scenarioId === "A");
      const scenarioB = openingScenario?.scenarios.find((scenario) => scenario.scenarioId === "B");
      const scenarioC = openingScenario?.scenarios.find((scenario) => scenario.scenarioId === "C");
      const scaling = diagnostics?.smartScaling;
      const deRisk = diagnostics?.deRisk;
      return [
        decision.id,
        decision.sessionId ?? "",
        decision.botId,
        decision.marketId,
        decision.asset,
        new Date(decision.timestamp).toISOString(),
        decision.decision,
        String(decision.edgeYes),
        String(decision.edgeNo),
        String(decision.edgeNet),
        String(decision.confidence),
        String(decision.polymarketAskYes),
        String(decision.polymarketAskNo),
        String(decision.positionSize),
        diagnostics === undefined ? "" : String(diagnostics.timeToExpirySeconds),
        diagnostics?.marketPhase ?? "",
        diagnostics?.cryptoPrice === null || diagnostics?.cryptoPrice === undefined ? "" : String(diagnostics.cryptoPrice),
        diagnostics?.targetPrice === null || diagnostics?.targetPrice === undefined ? "" : String(diagnostics.targetPrice),
        diagnostics?.distanceToTargetBps === null || diagnostics?.distanceToTargetBps === undefined ? "" : String(diagnostics.distanceToTargetBps),
        diagnostics === undefined ? "" : String(diagnostics.volatility1m),
        diagnostics === undefined ? "" : String(diagnostics.volatility5m),
        diagnostics === undefined ? "" : String(diagnostics.spreadPercent),
        diagnostics === undefined ? "" : String(diagnostics.liquidityScore),
        diagnostics === undefined ? "" : String(diagnostics.slippageEstimatePercent),
        diagnostics === undefined ? "" : String(diagnostics.signalScore),
        diagnostics === undefined ? "" : String(diagnostics.contradictionScore),
        diagnostics === undefined ? "" : String(diagnostics.agreementCount),
        diagnostics?.regime ?? "",
        diagnostics?.dataAgeMs === null || diagnostics?.dataAgeMs === undefined ? "" : String(diagnostics.dataAgeMs),
        diagnostics?.latencyMs === null || diagnostics?.latencyMs === undefined ? "" : String(diagnostics.latencyMs),
        comparator?.targetState ?? "",
        comparator?.tradeableSide ?? "",
        comparator === undefined ? "" : String(comparator.cushionScore),
        comparator === undefined ? "" : String(comparator.reversalRisk),
        comparator?.requiredMoveToFlipTarget === null || comparator?.requiredMoveToFlipTarget === undefined ? "" : String(comparator.requiredMoveToFlipTarget),
        comparator === undefined ? "" : String(comparator.volatilityAdjustedDistance),
        comparator === undefined ? "" : String(comparator.atrCushionRatio),
        forecast?.currentPositionRelativeToTarget ?? "",
        forecast === undefined ? "" : String(forecast.probabilityFinalAbove),
        forecast === undefined ? "" : String(forecast.probabilityFinalBelow),
        forecast?.forecast ?? "",
        forecast === undefined ? "" : String(forecast.confidence),
        diagnostics?.yesBid === null || diagnostics?.yesBid === undefined ? "" : String(diagnostics.yesBid),
        diagnostics?.noBid === null || diagnostics?.noBid === undefined ? "" : String(diagnostics.noBid),
        opportunity === undefined ? "" : String(opportunity.edgeYes),
        opportunity === undefined ? "" : String(opportunity.edgeNo),
        opportunity === undefined ? "" : String(opportunity.edgeYesNet),
        opportunity === undefined ? "" : String(opportunity.edgeNoNet),
        opportunity?.bestSide ?? "",
        forcedPick?.side ?? "",
        forcedPick === undefined ? "" : String(forcedPick.confidence),
        forcedPick?.reason ?? "",
        mandatory?.status ?? "",
        opportunity?.entryMode ?? "",
        mandatory === undefined ? "" : String(mandatory.starterEntryApproved),
        mandatory === undefined ? "" : String(mandatory.starterSizeUsd),
        openingSettings === undefined ? "" : String(openingSettings.enabled),
        openingSettings?.entryMode ?? "",
        openingEntry?.action ?? "",
        openingScenario === undefined ? "" : String(openingScenario.targetPrice),
        openingScenario === undefined ? "" : String(openingScenario.openingCryptoPrice),
        scenarioA === undefined ? "" : String(scenarioA.distanceToTargetUsd),
        scenarioA === undefined ? "" : String(scenarioA.distanceToTargetBps),
        scenarioA?.label ?? "",
        scenarioA?.side ?? "",
        scenarioA === undefined ? "" : String(scenarioA.probability),
        scenarioA === undefined ? "" : String(scenarioA.confidence),
        scenarioA?.entryPlan ?? "",
        scenarioA?.maxAcceptableAskPrice === undefined ? "" : String(scenarioA.maxAcceptableAskPrice),
        scenarioA?.invalidationCondition ?? "",
        scenarioA?.reasonCodes.join(" | ") ?? "",
        scenarioB?.label ?? "",
        scenarioB?.side ?? "",
        scenarioB === undefined ? "" : String(scenarioB.probability),
        scenarioB === undefined ? "" : String(scenarioB.confidence),
        scenarioB?.entryPlan ?? "",
        scenarioB?.maxAcceptableAskPrice === undefined ? "" : String(scenarioB.maxAcceptableAskPrice),
        scenarioB?.invalidationCondition ?? "",
        scenarioB?.reasonCodes.join(" | ") ?? "",
        scenarioC?.label ?? "",
        scenarioC?.side ?? "",
        scenarioC === undefined ? "" : String(scenarioC.probability),
        scenarioC === undefined ? "" : String(scenarioC.confidence),
        scenarioC?.entryPlan ?? "",
        scenarioC?.reasonCodes.join(" | ") ?? "",
        openingScenario?.primaryScenario.label ?? "",
        openingScenario?.primaryScenario.side ?? "",
        openingScenario === undefined ? "" : String(openingScenario.primaryScenario.probability),
        openingScenario === undefined ? "" : String(openingScenario.primaryScenario.confidence),
        openingScenario?.openingDecision ?? "",
        openingEntry?.explanation ?? "",
        openingEntry?.entryPrice === undefined ? "" : String(openingEntry.entryPrice),
        openingEntry === undefined ? "" : String(openingEntry.sizeUsd),
        openingEntry?.reasonCodes.join(" | ") ?? "",
        diagnostics === undefined ? "" : String(diagnostics.openingNearTargetOverrideUsed ?? false),
        diagnostics === undefined ? "" : String(diagnostics.legacySignalScoreIgnored ?? false),
        diagnostics?.preOpenBiasScore === undefined ? "" : String(diagnostics.preOpenBiasScore),
        diagnostics?.preOpenBiasDirection ?? "",
        diagnostics === undefined ? "" : String(diagnostics.primaryScenarioKeptDespiteNoTrade ?? false),
        diagnostics === undefined ? "" : String(diagnostics.forcedMinStakePaperUsed ?? false),
        diagnostics === undefined ? "" : String(diagnostics.lateForcedEntryUsed ?? false),
        scaling?.action ?? "",
        "",
        "",
        decision.positionSize > 0 ? String(decision.positionSize) : "",
        deRisk?.action ?? "",
        decision.blockedBy.join(" | "),
        [...(forecast?.reasonCodes ?? []), ...(opportunity?.reasonCodes ?? []), ...(mandatory?.reasonCodes ?? [])].join(" | "),
        [forecast?.explanation, opportunity?.explanation, mandatory?.explanation].filter(Boolean).join(" | "),
        diagnostics?.modelVersion ?? "",
        BLACK_GOAT_V3_CONFIG.version,
        decision.blockedBy.join(" | "),
        decision.reasons.join(" | "),
      ];
    }),
  ];

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function downloadJson(filename: string, payload: unknown) {
  downloadTextFile(sanitizeFilename(filename), JSON.stringify(payload, null, 2), "application/json");
}

function downloadCsv(filename: string, csv: string) {
  downloadTextFile(sanitizeFilename(filename), csv, "text/csv");
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function copyExportToClipboard(payload: unknown) {
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
}

function escapeCsvCell(value: string) {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function sanitizeFilename(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").toLowerCase();
}

function shortId(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function getDisplayProbability(market: PublicMarket, prices: Record<string, LivePrice>): BinaryMarketProbabilities {
  const upIndex = findOutcomeIndex(market.outcomes, "up", 0);
  const upAssetId = market.clobTokenIds[upIndex] ?? "";
  const upLivePrice = upAssetId.length > 0 ? prices[upAssetId] : undefined;
  const upMidpoint =
    upLivePrice === undefined ? null : calculateMidpoint(upLivePrice.bestBid ?? null, upLivePrice.bestAsk ?? null);
  const upBookPrice = upMidpoint ?? upLivePrice?.bestAsk ?? upLivePrice?.bestBid ?? null;
  const upPrice =
    upBookPrice ??
    (upLivePrice !== undefined && upLivePrice.eventType !== "price_change" ? upLivePrice.price : null) ??
    market.lastTradePrice ??
    readNumber(market.outcomePrices[upIndex]);

  if (upPrice === null || !Number.isFinite(upPrice)) {
    return {
      downProbability: null,
      source: "UNAVAILABLE",
      upProbability: null,
    };
  }

  const upProbability = clampPercent(upPrice * 100);
  const downProbability = clampPercent(100 - upProbability);
  if (Math.abs(upProbability + downProbability - 100) > 5) {
    console.error("Invalid binary probability calculation", {
      downProbability,
      market: market.slug,
      upProbability,
    });
  }

  return {
    downProbability,
    source: upMidpoint !== null ? "UP_TOKEN_MIDPOINT" : upBookPrice !== null ? "UP_TOKEN_BOOK" : "UP_TOKEN_LAST_PRICE",
    upProbability,
  };
}

function resolvePolymarketTarget(market: PublicMarket): number | null {
  if (market.priceToBeat !== null && Number.isFinite(market.priceToBeat)) {
    return market.priceToBeat;
  }

  const parsedFromDescription = extractTargetFromText(market.description);
  return parsedFromDescription;
}

function extractTargetFromText(value: string | null) {
  if (value === null) {
    return null;
  }

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

function findOutcomeIndex(outcomes: string[], needle: string, fallback: number) {
  const index = outcomes.findIndex((outcome) => outcome.toLowerCase() === needle);
  return index >= 0 ? index : fallback;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function calculateMidpoint(bestBid: number | null, bestAsk: number | null) {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function buildMarketDescription(
  outcomes: Array<{
    outcome: string;
    quote: {
      displayPrice: number | null;
    };
  }>,
) {
  const summary = outcomes
    .slice(0, 4)
    .map((item) => `${item.outcome} ${formatProbability(item.quote.displayPrice)}`)
    .join(" · ");

  return summary.length > 0 ? `Prediction market: ${summary} on Polymarket.` : "Prediction market on Polymarket.";
}

function buildMarketSchema(title: string, description: string, url: string | null) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    description,
    name: title,
    publisher: {
      "@type": "Organization",
      name: "Polymarket",
      url: "https://polymarket.com",
    },
    url: url ?? window.location.href,
  };
}

function safeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getOutcomeQuote(market: PublicMarket, prices: Record<string, LivePrice>, index: number) {
  const assetId = market.clobTokenIds[index] ?? "";
  const livePrice = assetId.length > 0 ? prices[assetId] : undefined;
  const initialPrice = readNumber(market.outcomePrices[index]);
  const fallbackBook = getFallbackOutcomeBook(market, index, initialPrice);
  const bookPrice = calculateMidpoint(livePrice?.bestBid ?? null, livePrice?.bestAsk ?? null) ?? livePrice?.bestAsk ?? livePrice?.bestBid ?? null;
  const displayPrice =
    bookPrice ??
    (livePrice !== undefined && livePrice.eventType !== "price_change" ? livePrice.price : null) ??
    initialPrice;

  return {
    assetId: assetId.length > 0 ? assetId : `outcome-${index}`,
    bestAsk: livePrice?.bestAsk ?? fallbackBook.bestAsk,
    bestBid: livePrice?.bestBid ?? fallbackBook.bestBid,
    displayPrice,
    eventType: livePrice?.eventType ?? "snapshot",
  };
}

function getFallbackOutcomeBook(market: PublicMarket, index: number, initialPrice: number | null) {
  const clampedInitial = initialPrice === null ? null : clampProbability(initialPrice);
  if (index === findOutcomeIndex(market.outcomes, "up", 0)) {
    return {
      bestAsk: market.bestAsk ?? (clampedInitial === null ? null : clampProbability(clampedInitial + 0.005)),
      bestBid: market.bestBid ?? (clampedInitial === null ? null : clampProbability(clampedInitial - 0.005)),
    };
  }

  return {
    bestAsk: market.bestBid === null ? (clampedInitial === null ? null : clampProbability(clampedInitial + 0.005)) : clampProbability(1 - market.bestBid),
    bestBid: market.bestAsk === null ? (clampedInitial === null ? null : clampProbability(clampedInitial - 0.005)) : clampProbability(1 - market.bestAsk),
  };
}

function inferMarketCategory(title: string) {
  const lowered = title.toLowerCase();
  if (lowered.includes("bitcoin") || lowered.includes("btc") || lowered.includes("ethereum") || lowered.includes("crypto")) {
    return "Crypto";
  }

  if (lowered.includes("oil") || lowered.includes("wti") || lowered.includes("gold")) {
    return "Finance";
  }

  if (lowered.includes("election") || lowered.includes("president") || lowered.includes("congress")) {
    return "Politics";
  }

  if (lowered.includes("nba") || lowered.includes("nfl") || lowered.includes("sports")) {
    return "Sports";
  }

  return "Market";
}

function inferCryptoChartLabel(market: PublicMarket) {
  const text = `${market.question ?? ""} ${market.slug ?? ""}`.toLowerCase();
  if (text.includes("bitcoin") || text.includes("btc")) {
    return "BTC";
  }

  if (text.includes("ethereum") || text.includes("eth")) {
    return "ETH";
  }

  if (text.includes("solana") || text.includes("sol")) {
    return "SOL";
  }

  if (text.includes("xrp") || text.includes("ripple")) {
    return "XRP";
  }

  if (text.includes("doge") || text.includes("dogecoin")) {
    return "DOGE";
  }

  if (text.includes("hype") || text.includes("hyperliquid")) {
    return "HYPE";
  }

  if (text.includes("bnb")) {
    return "BNB";
  }

  return inferMarketCategory(market.question ?? "Crypto");
}

function formatProbability(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  const digits = value > 0 && value < 0.01 ? 2 : 1;
  return `${(value * 100).toFixed(digits)}%`;
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return `${value.toFixed(1)}%`;
}

function formatCents(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return `${Math.round(value * 100)}¢`;
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

function formatOptionalMarketValue(value: number | null, label: string) {
  return value === null || !Number.isFinite(value) ? label : `${formatUsd(value)} ${label}`;
}

function formatSignedUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "$0.00";
  }

  const formatted = formatUsd(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${formatted}`;
}

function formatPercentNumber(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "0.0%";
  }
  return `${value.toFixed(1)}%`;
}

function formatRatio(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "0.00";
  }
  return value.toFixed(2);
}

function formatCompactUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value >= 1_000 ? 0 : 2,
    minimumFractionDigits: value >= 1_000 ? 0 : 2,
    style: "currency",
  }).format(value);
}

function formatCryptoUsd(value: number | null, symbol: string) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  const digits = getCryptoPriceDigits(value, symbol);
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "currency",
  }).format(value);
}

function formatSignedCryptoUsd(value: number | null, symbol: string) {
  if (value === null || !Number.isFinite(value)) {
    return "$0.00";
  }

  return `${value >= 0 ? "+" : "-"}${formatCryptoUsd(Math.abs(value), symbol)}`;
}

function formatTargetDistanceLabel(diff: number, targetPrice: number, symbol: string) {
  const bps = targetPrice <= 0 ? 0 : (diff / targetPrice) * 10_000;
  return `${formatSignedCryptoUsd(diff, symbol)} · ${bps >= 0 ? "+" : ""}${bps.toFixed(1)} bps`;
}

function formatCryptoAxisUsd(value: number | null, symbol: string) {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }

  return formatCryptoUsd(value, symbol);
}

function getCryptoPriceDigits(value: number, symbol: string) {
  if (symbol === "doge") {
    return 5;
  }

  if (symbol === "xrp") {
    return 4;
  }

  if (value < 1) {
    return 5;
  }

  if (value < 10) {
    return 4;
  }

  if (value < 100) {
    return 3;
  }

  return 2;
}

function formatChartTime(value: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}

function formatPreciseTime(value: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatTimeRemaining(value: string | null) {
  const seconds = getTimeRemainingSeconds(value);
  if (seconds === null) {
    return "En attente";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function getTimeRemainingSeconds(value: string | null) {
  if (value === null) {
    return null;
  }

  const endMs = Date.parse(value);
  if (Number.isNaN(endMs)) {
    return null;
  }

  return Math.max(0, Math.floor((endMs - Date.now()) / 1_000));
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

function formatFullLocalTime(value: string | null) {
  if (value === null) {
    return "unavailable";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unavailable";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    year: "numeric",
  }).format(date);
}

function formatRelativeTime(value: string | null, nowMs = Date.now()) {
  if (value === null) {
    return "unavailable";
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "unavailable";
  }

  const secondsAgo = Math.max(0, Math.floor((nowMs - timestamp) / 1_000));
  if (secondsAgo < 60) {
    return `il y a ${secondsAgo}s`;
  }

  const minutesAgo = Math.floor(secondsAgo / 60);
  if (minutesAgo < 60) {
    return `il y a ${minutesAgo}m`;
  }

  const hoursAgo = Math.floor(minutesAgo / 60);
  if (hoursAgo < 24) {
    return `il y a ${hoursAgo}h`;
  }

  const daysAgo = Math.floor(hoursAgo / 24);
  return `il y a ${daysAgo}j`;
}

function formatCount(value: number | null) {
  return value === null || !Number.isFinite(value) ? "unavailable" : String(Math.round(value));
}

function formatTraderWsDetail(meta: TradersWsMeta, nowMs: number) {
  if (meta.lastWsEventAt === null) {
    return "waiting for events";
  }

  if (meta.lastTradeEventAt === null) {
    return "LIVE - waiting for trades";
  }

  const secondsAgo = Math.max(0, Math.floor((nowMs - new Date(meta.lastTradeEventAt).getTime()) / 1_000));
  return secondsAgo > 30 ? `LIVE - no trade for ${secondsAgo}s` : "LIVE - receiving trades";
}

function deriveTraderLiveStatus(status: LiveStatus, meta: TradersWsMeta, nowMs: number): LiveStatus {
  if (status !== "LIVE") {
    return status;
  }

  if (meta.lastTradeEventAt === null) {
    return meta.lastWsEventAt === null ? "CONNECTING" : "STALE";
  }

  const secondsAgo = Math.max(0, Math.floor((nowMs - new Date(meta.lastTradeEventAt).getTime()) / 1_000));
  return secondsAgo > 60 ? "STALE" : "LIVE";
}

function shortWallet(value: string | null) {
  if (value === null) {
    return "unavailable";
  }

  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getInitials(value: string) {
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    return "T";
  }

  if (cleaned.startsWith("0x")) {
    return cleaned.slice(2, 4).toUpperCase();
  }

  const parts = cleaned.split(/[\s_-]+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "T"}${parts[1]?.[0] ?? ""}`.toUpperCase();
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

function readTradersWsMeta(message: ServerMessage): TradersWsMeta {
  return {
    lastTradeEventAt: readString(message.lastTradeEventAt),
    lastWsEventAt: readString(message.lastWsEventAt),
    newestTradeAt: readString(message.newestTradeAt),
    secondsSinceLastTradeEvent: readNumber(message.secondsSinceLastTradeEvent),
    tradesReceivedPerMinute: readNumber(message.tradesReceivedPerMinute),
    wsEventsPerMinute: readNumber(message.wsEventsPerMinute),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedTrade(value: unknown): value is NormalizedTrade {
  return isRecord(value) && typeof value.id === "string";
}

function isActiveTrader(value: unknown): value is ActiveTrader {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.wallet === "string" &&
    isRecord(value.scores)
  );
}
