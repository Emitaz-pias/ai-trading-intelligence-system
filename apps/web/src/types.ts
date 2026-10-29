export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; source?: string };
export type ReferenceQuote = { price: number | null; status: 'fresh' | 'stale' | 'unavailable'; source: string; asOf: string | null; ageSeconds: number | null; checkedAt: string };
export type ReferenceScenario = { side: 'buy' | 'sell'; level: number | null; state: string; grade: 'A+' | 'A' | 'B' | 'C'; latestM15Close: number | null; trigger: string; confirmation: string; invalidation: string; gradeReason: string };
export type MarketStatus = {
  mode: 'illustrative' | 'provider' | 'xaus' | 'disabled'; connectionStatus: 'connected' | 'delayed' | 'disconnected' | 'illustrative';
  connectionLabel: string; currentPrice: number | null; latestTickAt: string | null; lastSuccessfulUpdateAt: string | null;
  isFresh: boolean; warnings: string[]; provider?: string; symbol?: string; accountServer?: string | null;
};
export type Zone = { type: string; low: number; high: number; mid: number; tests: number; strength: string; createdAt: string; lastTestAt: string; ruleId: string; invalidation: string };
export type StructureEvent = { type: string; direction: string; level: number; time: string; referenceSwingTime: string; confirmed: boolean; ruleId: string };
export type SupplyDemandZone = { type: 'supply' | 'demand'; low: number; high: number; mid: number; baseFrom: string; baseTo: string; displacementAt: string; tests: number; status: string; strength: string; ruleId: string; invalidation: string };
export type Liquidity = { levels: { type: string; price: number; from: string; to: string; ruleId: string; potentialSweepAt?: string }[]; sessions: { session: string; date: string; timezone: string; high: number; low: number; from: string; to: string; ruleId: string }[]; periods: Record<string, { period: string; high: number; low: number; open: number; close: number; from: string; to: string; ruleId: string }> };
export type AnalysisResult = {
  status: string; timeframe: string; regime?: string; asOf?: string; currentClose?: number; atr14?: number;
  volatility?: { state: string; shortToLongTrueRangeRatio: number; ruleId: string };
  swings?: { kind: string; time: string; confirmedAt: string; price: number; label: string }[];
  structure?: StructureEvent[]; provisionalWickPenetrations?: StructureEvent[]; zones?: Zone[]; supplyDemand?: SupplyDemandZone[]; liquidity?: Liquidity;
  nearestSupport?: Zone | null; nearestResistance?: Zone | null; patterns?: { type: string; level: number; time: string; ruleId: string; invalidation: string }[];
  candlesAnalyzed?: number; message?: string; limitations?: string[];
};
export type ConditionalPlan = {
  state: string; direction: string; setupType?: string; timeframe?: string; lastClosedClose?: number;
  relevantZone?: { low: number; high: number; mid: number; type: string; sourceEvent?: string } | null;
  conditions?: string[]; invalidation?: string; reasonsToAvoid?: string[]; ruleId?: string;
  breakoutEvent?: StructureEvent; rejectionCandleTime?: string | null; explanation?: string;
  underlyingState?: string; newsFilterActive?: boolean; newsEvent?: { name: string; scheduledAt: string; dateSpan: number; forecast?: string; previous?: string };
};
export type AnalysisResponse = { sourceMode: string; marketStatus: MarketStatus; results: Record<string, AnalysisResult>; report: { timeframes: Record<string, { role: string; status: string; regime?: string; currentClose?: number; supplyDemand?: SupplyDemandZone[]; liquidity?: Liquidity }>; conflict: boolean; explanations: string[]; currentPriceLocation?: { price?: number; status: string }; alternativeScenarios?: string[]; noTradeConditions?: string[] }; tradePlan: ConditionalPlan };
export type Trade = { _id: string; instrument: string; side: 'buy' | 'sell'; entryPrice: number; positionSize: number; initialStopLoss: number; currentStopLoss: number; targets: { label: string; price: number; reachedAt?: string }[]; thesis: string; setupType: string; strategyId: string; openedAt: string; status: string; closeOutcome?: string; resultMoney?: number };
export type Alert = { _id: string; title: string; instrument: string; timeframe?: string; price?: number; reason: string; suggestedAction?: string; href?: string; triggeredAt: string; category: string };
export type RiskStatus = { configured: Record<string, number>; tradesToday: number; setupsThisSession: number; activeTrades: number; consecutiveLosses: number; realizedLossToday: number; realizedDrawdownToday: number; riskAvailable: boolean; limitsBreached: boolean; note: string };
export type Settings = { timezone: string; accountEquity?: number; accountCurrency?: string; maxRiskPercent: number; maxDailyLossPercent: number; maxTradesPerDay: number; maxConsecutiveLosses: number; maxDailyDrawdownPercent: number; maxSimultaneousTrades: number; cooldownMinutes: number; alertCooldownMinutes: number; maxSetupsPerSession: number; newsFilterEnabled: boolean; newsMinutesBefore: number; newsMinutesAfter: number; telegramEnabled: boolean; telegramChatId?: string; notificationCategories: string[]; quietHours?: { start?: string; end?: string } };
export type NewsEvent = { _id: string; provider: string; eventId: string; name: string; country: string; currency: string; impact: string; scheduledAt: string; dateSpan: number; actual?: string; forecast?: string; previous?: string; source?: string; sourceURL?: string; lastProviderUpdateAt?: string };
