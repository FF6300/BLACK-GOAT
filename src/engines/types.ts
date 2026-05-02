export type CryptoAsset = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE" | "BNB" | "HYPE";
export type ForecastLabel = "ABOVE_TARGET" | "BELOW_TARGET" | "UNCLEAR";
export type MarketSide = "YES" | "NO" | "NONE";

export type Candle = {
  close: number;
  high: number;
  low: number;
  open: number;
  timestamp: number;
  volume?: number;
};

export type OrderflowSnapshot = {
  aggressiveBuyRatio?: number;
  cvdScore?: number;
  imbalance?: number;
};

export type VolumeSnapshot = {
  volumeSpikeScore?: number;
  vwap?: number;
};

export type MarketRegime = "trend" | "range" | "high_volatility" | "low_liquidity" | "news_event";

export type RawPolymarketMarket = {
  acceptingOrders?: boolean | null;
  bestAsk?: number | null;
  bestBid?: number | null;
  clobTokenIds?: string[];
  description?: string | null;
  endDate?: string | null;
  eventStartTime?: string | null;
  id?: string | null;
  liquidity?: number | null;
  outcomePrices?: string[];
  outcomes?: string[];
  priceToBeat?: number | null;
  question?: string | null;
  slug?: string | null;
};

export type ParsedTarget = {
  source: "market_priceToBeat" | "text" | "unavailable";
  targetPrice: number | null;
};

export type Crypto5mMarket = {
  marketId: string;
  asset: CryptoAsset;
  question: string;
  rules?: string;
  targetPrice: number;
  startTime: number;
  expiryTime: number;
  timeRemainingSeconds: number;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  spreadPercent: number | null;
  liquidityScore: number | null;
};

export type FinalSettlementInput = {
  asset: string;
  targetPrice: number;
  currentPrice: number;
  timeRemainingSeconds: number;
  isOpeningScenarioBot?: boolean;
  ohlcv1m: Candle[];
  ohlcv3m?: Candle[];
  ohlcv5m: Candle[];
  ohlcv15m: Candle[];
  ohlcv1h: Candle[];
  ohlcv4h: Candle[];
  ohlcv1d: Candle[];
  ohlcv1w?: Candle[];
  ohlcv1M?: Candle[];
  orderflow?: OrderflowSnapshot;
  volumeProfile?: VolumeSnapshot;
  marketRegime?: MarketRegime;
};

export type FinalSettlementForecast = {
  forecast: ForecastLabel;
  probabilityFinalAbove: number;
  probabilityFinalBelow: number;
  confidence: number;
  currentPositionRelativeToTarget: "ABOVE" | "BELOW" | "NEAR";
  distanceToTargetUsd: number;
  distanceToTargetPercent: number;
  distanceToTargetBps: number;
  momentumDirection: "UP" | "DOWN" | "NEUTRAL";
  momentumStrength: number;
  trendAlignmentScore: number;
  reversalScore: number;
  continuationScore: number;
  reasonCodes: string[];
  explanation: string;
  openingNearTargetOverrideUsed?: boolean;
  preOpenBiasDirection?: "ABOVE_TARGET" | "BELOW_TARGET" | "NEUTRAL";
  preOpenBiasScore?: number;
};

export type EntryOpportunityInput = {
  forecast: FinalSettlementForecast;
  yesAsk: number;
  noAsk: number;
  yesBid?: number;
  noBid?: number;
  spreadPercent: number;
  liquidityScore: number;
  timeRemainingSeconds: number;
};

export type EntryMode =
  | "ABOVE_VALUE_ENTRY"
  | "ABOVE_CONFIRMATION_ENTRY"
  | "BELOW_VALUE_ENTRY"
  | "BELOW_CONFIRMATION_ENTRY"
  | "NO_EDGE"
  | "UNCLEAR";

export type EntryOpportunityResult = {
  bestSide: MarketSide;
  edgeYes: number;
  edgeNo: number;
  edgeYesNet: number;
  edgeNoNet: number;
  isYesUndervalued: boolean;
  isNoUndervalued: boolean;
  entryMode: EntryMode;
  maxAcceptableYesPrice: number;
  maxAcceptableNoPrice: number;
  decision:
    | "STARTER_ENTRY_APPROVED"
    | "WAITING_FOR_BETTER_PRICE"
    | "NO_TRADE_PRICE_TOO_EXPENSIVE"
    | "WAITING_FOR_CLARITY"
    | "NO_TRADE";
  reasonCodes: string[];
  explanation: string;
};

export type MarketDecisionStatus =
  | "FORCED_PAPER_PICK_ONLY"
  | "STARTER_ENTRY_APPROVED"
  | "WAITING_FOR_BETTER_PRICE"
  | "WAITING_FOR_CLARITY"
  | "NO_TRADE_PRICE_TOO_EXPENSIVE"
  | "NO_TRADE_RISK_BLOCKED"
  | "NO_TRADE_LOW_LIQUIDITY"
  | "NO_TRADE_WIDE_SPREAD";

export type ForcedPaperPick = {
  side: "YES" | "NO";
  confidence: number;
  reason: string;
  wouldHaveEntered: boolean;
  blockedReason?: string;
};

export type RiskDecision = {
  approved: boolean;
  blockedBy: string[];
  adjustedPositionSize: number;
};

export type MandatoryDecisionResult = {
  forcedPaperPick: ForcedPaperPick;
  status: MarketDecisionStatus;
  side: MarketSide;
  starterEntryApproved: boolean;
  starterSizeUsd: number;
  reasonCodes: string[];
  explanation: string;
};

export type PaperPosition = {
  addCount?: number;
  entrySizeUsd: number;
  entryTokenPrice: number;
  marketId: string;
  side: "YES" | "NO";
};

export type SmartScalingInput = {
  position: PaperPosition;
  currentForecast: FinalSettlementForecast;
  currentOpportunity: EntryOpportunityResult;
  currentYesAsk: number;
  currentNoAsk: number;
  currentPrice: number;
  targetPrice: number;
  timeRemainingSeconds: number;
};

export type SmartScalingDecision = {
  action:
    | "NO_ADD"
    | "VALUE_ADD_APPROVED"
    | "CONFIRMATION_ADD_APPROVED"
    | "ADD_BLOCKED_SCENARIO_WEAKENED"
    | "ADD_BLOCKED_EDGE_TOO_LOW"
    | "ADD_BLOCKED_TARGET_RISK"
    | "ADD_BLOCKED_MAX_POSITION"
    | "ADD_BLOCKED_TIME"
    | "DE_RISK"
    | "EXIT";
  addSizeUsd?: number;
  reasonCodes: string[];
  explanation: string;
};

export type DeRiskAction = "HOLD" | "TAKE_PARTIAL_PROFIT" | "EXIT_SCENARIO_INVALIDATED" | "EXIT_EDGE_GONE" | "EXIT_TIME_RISK" | "EXIT_OPPOSITE_FORECAST";

export type DeRiskInput = {
  position: PaperPosition;
  forecast: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
  currentTokenPrice: number;
  timeRemainingSeconds: number;
};

export type DeRiskDecision = {
  action: DeRiskAction;
  reasonCodes: string[];
  explanation: string;
};

export type OpeningEntryMode = "OFF" | "IF_APPROVED" | "FORCED_PAPER_ONLY" | "FORCED_MIN_STAKE_PAPER";

export type OpeningScenarioSettings = {
  allowedAssets: CryptoAsset[];
  doNotForceUnclearBecauseNearTargetAtOpen: boolean;
  enabled: boolean;
  entryDelayMs: number;
  entryMode: OpeningEntryMode;
  entryWindowSeconds: number;
  maxOpeningStakeUsd: number;
  maxSpreadPercent: number;
  minConfidenceForOpeningEntry: number;
  minEdgeNetForOpeningEntry: number;
  minLiquidityScore: number;
  minStakeUsd: number;
  nearTargetAtOpenIsAllowed: boolean;
  openAtMarketStart: boolean;
  smartScalingAfterOpening: boolean;
  usePreOpenBiasWhenNearTarget: boolean;
};

export type OpeningScenarioInput = {
  marketId: string;
  asset: CryptoAsset;
  targetPrice: number;
  openingCryptoPrice: number;
  currentPrice: number;
  yesAsk: number;
  noAsk: number;
  yesBid?: number;
  noBid?: number;
  spreadPercent: number;
  liquidityScore: number;
  startTime: number;
  expiryTime: number;
  timeRemainingSeconds: number;
  candles1m: Candle[];
  candles3m?: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  candles4h: Candle[];
  candles1d: Candle[];
  finalSettlementForecast: FinalSettlementForecast;
  opportunity: EntryOpportunityResult;
};

export type OpeningScenario = {
  scenarioId: "A" | "B" | "C";
  label: "ABOVE_TARGET" | "BELOW_TARGET" | "UNCLEAR_CHOP";
  side: "YES" | "NO" | "NONE";
  probability: number;
  confidence: number;
  expectedPath: string;
  openingPrice: number;
  targetPrice: number;
  distanceToTargetUsd: number;
  distanceToTargetBps: number;
  expectedFinalPosition: "ABOVE" | "BELOW" | "UNCLEAR";
  maxAcceptableAskPrice?: number;
  entryPlan: "ENTER_AT_OPEN" | "WAIT_FOR_BETTER_PRICE" | "WAIT_FOR_CONFIRMATION" | "NO_TRADE";
  invalidationCondition: string;
  reasonCodes: string[];
  explanation: string;
};

export type OpeningScenarioResult = {
  marketId: string;
  asset: CryptoAsset;
  targetPrice: number;
  openingCryptoPrice: number;
  currentPrice: number;
  scenarios: OpeningScenario[];
  primaryScenario: OpeningScenario;
  secondaryScenario: OpeningScenario;
  dangerScenario: OpeningScenario;
  forcedPaperPick: {
    side: "YES" | "NO";
    confidence: number;
    scenarioId: "A" | "B";
    reason: string;
  };
  openingDecision:
    | "ENTER_AT_OPEN"
    | "WAIT_FOR_BETTER_PRICE"
    | "WAIT_FOR_CONFIRMATION"
    | "NO_TRADE_PRICE_TOO_EXPENSIVE"
    | "NO_TRADE"
    | "FORCED_PAPER_ONLY";
  primaryScenarioKeptDespiteNoTrade?: boolean;
  explanation: string;
};

export type OpeningEntryInput = {
  settings: OpeningScenarioSettings;
  scenarioResult: OpeningScenarioResult;
  opportunity: EntryOpportunityResult;
  riskDecision: RiskDecision;
  market: Crypto5mMarket;
};

export type OpeningEntryDecision = {
  action:
    | "OPEN_STARTER_POSITION"
    | "FORCED_PAPER_PICK_ONLY"
    | "WAIT_FOR_BETTER_PRICE"
    | "WAIT_FOR_CONFIRMATION"
    | "NO_TRADE_PRICE_TOO_EXPENSIVE"
    | "NO_TRADE";
  side: "YES" | "NO" | "NONE";
  sizeUsd: number;
  entryPrice?: number;
  forcedEntryDespiteWideSpread?: boolean;
  lateForcedEntryUsed?: boolean;
  forcedMinStakePaperUsed?: boolean;
  reasonCodes: string[];
  explanation: string;
};
