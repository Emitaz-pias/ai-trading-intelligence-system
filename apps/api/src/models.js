const mongoose = require('mongoose');
const { Schema } = mongoose;
const candleRetentionDays = Math.max(0, Number(process.env.MARKET_DATA_RETENTION_DAYS) || 1825);
const alertRetentionDays = Math.max(0, Number(process.env.ALERT_RETENTION_DAYS) || 1095);
const auditRetentionDays = Math.max(0, Number(process.env.AUDIT_RETENTION_DAYS) || 2555);

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
}, { timestamps: true });

const settingsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  timezone: { type: String, default: 'Asia/Dhaka', maxlength: 64 },
  accountEquity: { type: Number, min: 0 },
  accountCurrency: { type: String, maxlength: 10 },
  maxRiskPercent: { type: Number, default: 1, min: 0, max: 100 },
  maxDailyLossPercent: { type: Number, default: 3, min: 0, max: 100 },
  maxTradesPerDay: { type: Number, default: 3, min: 0, max: 100 },
  maxConsecutiveLosses: { type: Number, default: 3, min: 0, max: 100 },
  maxDailyDrawdownPercent: { type: Number, default: 5, min: 0, max: 100 },
  maxSimultaneousTrades: { type: Number, default: 2, min: 0, max: 100 },
  cooldownMinutes: { type: Number, default: 60, min: 0, max: 10080 },
  alertCooldownMinutes: { type: Number, default: 5, min: 0, max: 10080 },
  maxSetupsPerSession: { type: Number, default: 2, min: 0, max: 100 },
  telegramChatId: { type: String, maxlength: 64, select: false },
  telegramEnabled: { type: Boolean, default: false },
  quietHours: { start: String, end: String },
  newsFilterEnabled: { type: Boolean, default: false },
  newsMinutesBefore: { type: Number, default: 30, min: 0, max: 1440 },
  newsMinutesAfter: { type: Number, default: 15, min: 0, max: 1440 },
  notificationCategories: { type: [String], default: ['trade', 'data', 'system'] },
}, { timestamps: true });

const candleSchema = new Schema({
  provider: { type: String, required: true }, symbol: { type: String, required: true },
  timeframe: { type: String, required: true }, time: { type: Date, required: true },
  open: { type: Number, required: true }, high: { type: Number, required: true },
  low: { type: Number, required: true }, close: { type: Number, required: true }, volume: { type: Number, default: 0 },
}, { versionKey: false });
candleSchema.index({ provider: 1, symbol: 1, timeframe: 1, time: 1 }, { unique: true });
candleSchema.index({ symbol: 1, timeframe: 1, time: -1 });
if (candleRetentionDays > 0) candleSchema.index({ time: 1 }, { expireAfterSeconds: candleRetentionDays * 86400 });

const snapshotSchema = new Schema({
  provider: { type: String, required: true }, symbol: { type: String, required: true },
  time: { type: Date, required: true }, bid: Number, ask: Number, last: Number,
  observedAt: { type: Date, required: true },
}, { versionKey: false });
snapshotSchema.index({ provider: 1, symbol: 1 }, { unique: true });

const collectorStateSchema = new Schema({
  provider: { type: String, required: true, unique: true }, symbol: String,
  status: { type: String, enum: ['connected', 'delayed', 'disconnected', 'error'], default: 'disconnected' },
  lastSeenAt: Date, lastTickAt: Date, terminalConnected: Boolean, accountServer: { type: String, maxlength: 100 }, symbolInfo: Schema.Types.Mixed,
  missingCandleGaps: Schema.Types.Mixed, lastError: { type: String, maxlength: 500 },
}, { timestamps: true });

const tradeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  instrument: { type: String, required: true, default: 'XAUUSD' }, side: { type: String, enum: ['buy', 'sell'], required: true },
  entryPrice: { type: Number, required: true, min: 0 }, positionSize: { type: Number, required: true, min: 0 },
  initialStopLoss: { type: Number, required: true, min: 0 }, currentStopLoss: { type: Number, required: true, min: 0 },
  targets: [{ label: String, price: Number, reachedAt: Date }], thesis: { type: String, maxlength: 2000 },
  setupType: { type: String, enum: ['breakout', 'retest', 'other'], default: 'other' },
  strategyId: { type: String, maxlength: 100 }, openedAt: { type: Date, required: true },
  brokerPositionId: { type: String, maxlength: 100 }, status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  closedAt: Date, closeOutcome: { type: String, enum: ['win', 'loss', 'breakeven'] }, resultMoney: Number,
}, { timestamps: true });
tradeSchema.index({ userId: 1, status: 1, openedAt: -1 });

const alertSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tradeId: { type: Schema.Types.ObjectId, ref: 'MonitoredTrade' }, eventKey: { type: String, required: true },
  category: { type: String, enum: ['trade', 'data', 'system', 'news'], default: 'trade' },
  title: { type: String, required: true, maxlength: 160 }, instrument: { type: String, default: 'XAUUSD' },
  timeframe: String, price: Number, reason: { type: String, required: true, maxlength: 1000 },
  suggestedAction: String, href: String, triggeredAt: { type: Date, default: Date.now },
}, { timestamps: true });
alertSchema.index({ userId: 1, eventKey: 1 }, { unique: true });
alertSchema.index({ userId: 1, triggeredAt: -1 });
if (alertRetentionDays > 0) alertSchema.index({ triggeredAt: 1 }, { expireAfterSeconds: alertRetentionDays * 86400 });

const deliverySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  alertId: { type: Schema.Types.ObjectId, ref: 'AlertEvent', required: true },
  channel: { type: String, enum: ['website', 'telegram'], required: true },
  status: { type: String, enum: ['available', 'pending', 'delivered', 'retrying', 'failed'], required: true },
  attempts: { type: Number, default: 0 }, nextAttemptAt: Date, deliveredAt: Date, lastError: { type: String, maxlength: 300 },
}, { timestamps: true });
deliverySchema.index({ alertId: 1, channel: 1 }, { unique: true });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
if (alertRetentionDays > 0) deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: alertRetentionDays * 86400 });

const auditSchema = new Schema({ userId: Schema.Types.ObjectId, action: String, entity: String, entityId: String, metadata: Schema.Types.Mixed }, { timestamps: true });
if (auditRetentionDays > 0) auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: auditRetentionDays * 86400 });

const newsSchema = new Schema({
  provider: { type: String, required: true }, eventId: { type: String, required: true },
  name: { type: String, required: true, maxlength: 180 }, country: String, currency: String,
  impact: { type: String, enum: ['low', 'medium', 'high'] }, importance: Number,
  scheduledAt: { type: Date, required: true }, dateSpan: Number, actual: String, forecast: String, previous: String,
  source: String, sourceURL: String, lastProviderUpdateAt: Date,
}, { timestamps: true });
newsSchema.index({ provider: 1, eventId: 1 }, { unique: true });
newsSchema.index({ currency: 1, impact: 1, scheduledAt: 1 });

const model = (name, schema, collection) => mongoose.models[name] || mongoose.model(name, schema, collection);
module.exports = {
  User: model('User', userSchema, 'users'), UserSettings: model('UserSettings', settingsSchema, 'userSettings'),
  MarketCandle: model('MarketCandle', candleSchema, 'marketCandles'), MarketSnapshot: model('MarketSnapshot', snapshotSchema, 'marketSnapshots'),
  CollectorState: model('CollectorState', collectorStateSchema, 'collectorStates'), AnalysisResult: model('AnalysisResult', new Schema({ symbol: String, source: String, asOf: Date, results: Schema.Types.Mixed, report: Schema.Types.Mixed }, { timestamps: true }), 'analysisResults'),
  DetectedZone: model('DetectedZone', new Schema({ symbol: String, timeframe: String, source: String, zone: Schema.Types.Mixed, createdAt: Date }, { timestamps: true }), 'detectedZones'),
  DetectedPattern: model('DetectedPattern', new Schema({ symbol: String, timeframe: String, source: String, pattern: Schema.Types.Mixed, createdAt: Date }, { timestamps: true }), 'detectedPatterns'),
  TradingSetup: model('TradingSetup', new Schema({ symbol: String, source: String, plan: Schema.Types.Mixed, asOf: Date }, { timestamps: true }), 'tradingSetups'),
  MonitoredTrade: model('MonitoredTrade', tradeSchema, 'monitoredTrades'), AlertEvent: model('AlertEvent', alertSchema, 'alertEvents'),
  NotificationDelivery: model('NotificationDelivery', deliverySchema, 'notificationDeliveries'),
  NewsEvent: model('NewsEvent', newsSchema, 'newsEvents'),
  NewsProviderState: model('NewsProviderState', new Schema({ provider: { type: String, required: true, unique: true }, lastAttemptAt: Date, lastSuccessfulAt: Date, lastError: { type: String, maxlength: 180 }, importedCount: Number }, { timestamps: true }), 'newsProviderState'),
  HistoricalReactionResult: model('HistoricalReactionResult', new Schema({ ruleId: String, sampleSize: Number, metrics: Schema.Types.Mixed, sourceRange: Schema.Types.Mixed }, { timestamps: true }), 'historicalReactionResults'),
  BacktestRun: model('BacktestRun', new Schema({ userId: { type: Schema.Types.ObjectId, index: true }, strategy: Schema.Types.Mixed, metrics: Schema.Types.Mixed, sourceRange: Schema.Types.Mixed, completedAt: Date }, { timestamps: true }), 'backtestRuns'),
  BacktestTrade: model('BacktestTrade', new Schema({ runId: { type: Schema.Types.ObjectId, index: true }, entryAt: Date, exitAt: Date, side: String, entry: Number, exit: Number, resultR: Number, setupType: String, exitReason: String, session: String, ruleId: String }, { timestamps: true }), 'backtestTrades'),
  TradingJournalEntry: model('TradingJournalEntry', new Schema({ userId: { type: Schema.Types.ObjectId, index: true }, tradeId: Schema.Types.ObjectId, notes: String, tags: [String], attachments: [String] }, { timestamps: true }), 'tradingJournalEntries'),
  AuditLog: model('AuditLog', auditSchema, 'auditLogs'),
};
