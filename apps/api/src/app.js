const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const {
  User, UserSettings, MarketCandle, MarketSnapshot, CollectorState, AnalysisResult, NewsEvent, NewsProviderState,
  MonitoredTrade, AlertEvent, NotificationDelivery, AuditLog, BacktestRun, BacktestTrade,
} = require('./models');
const { TIMEFRAMES, isFresh, isUtcTimestamp, validateCandle, tradeTriggers, makeConditionalPlan } = require('./rules');
const { dateKey, sessionKey, dailyLossLimitBreached, computeRisk } = require('./risk');
const { illustrativeCandles } = require('./illustrative');
const { createAlert, sendTelegram } = require('./notifications');
const { PROVIDER: NEWS_PROVIDER, activeNewsWindow } = require('./news');

const ACCESS_COOKIE = 'ati_session';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-secret-change-before-deploy-00000000');
const DATA_MODE = process.env.DATA_MODE === 'provider' ? 'provider' : process.env.NODE_ENV === 'production' ? 'disabled' : 'illustrative';
const MAX_TICK_AGE_SECONDS = Math.max(5, Number(process.env.MAX_TICK_AGE_SECONDS) || 30);
const TIMEFRAME_SECONDS = { M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const openAiSchema = {
  type: 'object',
  properties: {
    englishSummary: { type: 'string' }, banglaExplanation: { type: 'string' },
    confirmedFindings: { type: 'array', items: { type: 'string' } },
    hypotheses: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    waitFor: { type: 'array', items: { type: 'string' } },
    dataLimitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['englishSummary', 'banglaExplanation', 'confirmedFindings', 'hypotheses', 'conflicts', 'waitFor', 'dataLimitations'],
  additionalProperties: false,
};

function authToken(req) {
  const raw = req.cookies?.[ACCESS_COOKIE];
  if (!raw) return null;
  try { return jwt.verify(raw, JWT_SECRET, { audience: 'ati-web', issuer: 'ati-api' }); } catch { return null; }
}

function authentication(req, res, next) {
  const token = authToken(req);
  if (!token?.sub) return res.status(401).json({ error: 'Authentication required' });
  req.userId = token.sub;
  next();
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user._id.toString() }, JWT_SECRET, { audience: 'ati-web', issuer: 'ati-api', expiresIn: '8h' });
  res.cookie(ACCESS_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 * 1000 });
}

function parseFinite(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  return parsed;
}

function candlesFor(timeframe, limit) {
  if (DATA_MODE === 'illustrative') return Promise.resolve(illustrativeCandles(timeframe, limit));
  if (DATA_MODE === 'disabled') return Promise.resolve([]);
  return MarketCandle.find({ provider: 'fundingpips-mt5', symbol: process.env.MARKET_SYMBOL || 'XAUUSD', timeframe })
    .sort({ time: -1 }).limit(limit).lean().then((rows) => rows.reverse().map((row) => ({ time: row.time.toISOString(), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, source: row.provider })));
}

async function marketStatus() {
  if (DATA_MODE === 'illustrative') return {
    mode: 'illustrative', connectionStatus: 'illustrative', connectionLabel: 'Illustrative data only',
    currentPrice: null, latestTickAt: null, lastSuccessfulUpdateAt: null, isFresh: false,
    warnings: ['Generated candles are synthetic and do not represent a live or historical broker feed. No live price or actionable setup is available.'],
  };
  if (DATA_MODE === 'disabled') return {
    mode: 'disabled', connectionStatus: 'disconnected', connectionLabel: 'Feed not configured',
    currentPrice: null, latestTickAt: null, lastSuccessfulUpdateAt: null, isFresh: false,
    warnings: ['Production data mode is disabled until a collector and provider mode are configured.'],
  };
  if (mongoose.connection.readyState !== 1) return { mode: 'provider', connectionStatus: 'disconnected', connectionLabel: 'Database unavailable', currentPrice: null, latestTickAt: null, lastSuccessfulUpdateAt: null, isFresh: false, warnings: ['Market-data storage is unavailable.'] };
  const [state, snapshot] = await Promise.all([
    CollectorState.findOne({ provider: 'fundingpips-mt5' }).lean(),
    MarketSnapshot.findOne({ provider: 'fundingpips-mt5', symbol: process.env.MARKET_SYMBOL || 'XAUUSD' }).lean(),
  ]);
  const now = new Date();
  const tickFresh = isFresh(now, snapshot?.time, MAX_TICK_AGE_SECONDS);
  const heartbeatFresh = isFresh(now, state?.lastSeenAt, MAX_TICK_AGE_SECONDS * 2);
  const connected = Boolean(state?.terminalConnected && tickFresh && heartbeatFresh);
  const connectionStatus = connected ? 'connected' : heartbeatFresh ? 'delayed' : 'disconnected';
  const warnings = [];
  if (!tickFresh) warnings.push('Last tick is stale; the current price is withheld.');
  if (!heartbeatFresh) warnings.push('Collector heartbeat is stale or missing.');
  if (!state?.terminalConnected) warnings.push('MT5 terminal is not connected.');
  const gaps = state?.missingCandleGaps || {};
  if (Object.values(gaps).some((items) => Array.isArray(items) && items.length)) warnings.push('Possible missing candles were detected; session closures may explain some gaps.');
  const currentPrice = connected ? (Number(snapshot.last) > 0 ? snapshot.last : (snapshot.bid + snapshot.ask) / 2) : null;
  return {
    mode: 'provider', connectionStatus, connectionLabel: connected ? 'Connected · fresh feed' : connectionStatus === 'delayed' ? 'Delayed · price hidden' : 'Disconnected · price hidden',
    currentPrice, bid: connected ? snapshot.bid : null, ask: connected ? snapshot.ask : null,
    latestTickAt: snapshot?.time || null, lastSuccessfulUpdateAt: state?.lastSeenAt || null,
    isFresh: connected, maxTickAgeSeconds: MAX_TICK_AGE_SECONDS, provider: state?.provider || 'fundingpips-mt5',
    symbol: state?.symbol || process.env.MARKET_SYMBOL || 'XAUUSD', symbolInfo: state?.symbolInfo || null,
    accountServer: state?.accountServer || null, missingCandleGaps: gaps, warnings,
  };
}

async function buildAnalysis(userId) {
  const candles = {};
  for (const timeframe of ['D1', 'H4', 'H1', 'M30', 'M15', 'M5']) candles[timeframe] = await candlesFor(timeframe, 600);
  const analysisUrl = process.env.ANALYSIS_URL || 'http://localhost:8001';
  const response = await fetch(`${analysisUrl}/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: process.env.MARKET_SYMBOL || 'XAUUSD', candles }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Object.assign(new Error('Analysis service failed'), { status: 503 });
  const data = await response.json();
  const status = await marketStatus();
  const plan = makeConditionalPlan(data, status.isFresh, DATA_MODE, candles);
  if (userId && mongoose.connection.readyState === 1) {
    const settings = await UserSettings.findOne({ userId }).lean();
    if (settings?.newsFilterEnabled) {
      const now = new Date();
      const afterMs = Number(settings.newsMinutesAfter ?? 15) * 60_000;
      const newsEvents = await NewsEvent.find({ provider: NEWS_PROVIDER, currency: 'USD', impact: 'high', scheduledAt: { $gte: new Date(now.getTime() - afterMs), $lte: new Date(now.getTime() + 86_400_000) } }).sort({ scheduledAt: 1 }).limit(100).lean();
      const activeEvent = activeNewsWindow(newsEvents, settings, now);
      if (activeEvent && plan.state !== 'DATA_UNAVAILABLE') {
        plan.underlyingState = plan.state;
        plan.state = 'NO_TRADE';
        plan.newsFilterActive = true;
        plan.newsEvent = { name: activeEvent.name, scheduledAt: activeEvent.scheduledAt, dateSpan: activeEvent.dateSpan, forecast: activeEvent.forecast, previous: activeEvent.previous };
        plan.reasonsToAvoid = [...(plan.reasonsToAvoid || []), `Configured high-impact news filter is active around ${activeEvent.name}; wait for the event window to pass and reassess.`];
      }
    }
  }
  const record = { symbol: process.env.MARKET_SYMBOL || 'XAUUSD', source: DATA_MODE, asOf: data.report?.asOf ? new Date(data.report.asOf) : undefined, results: data.results, report: data.report };
  if (mongoose.connection.readyState === 1) await AnalysisResult.create(record);
  return { sourceMode: DATA_MODE, marketStatus: status, results: data.results, report: data.report, tradePlan: plan };
}

async function createTradeAlert(trade, event, cooldownMinutes = 5) {
  const cooldownBucket = cooldownMinutes > 0 ? Math.floor(Date.now() / (cooldownMinutes * 60_000)) : 'deduped';
  return createAlert({
    userId: trade.userId, tradeId: trade._id, eventKey: `${trade._id}:${event.type}:${event.key}:cooldown:${cooldownBucket}`,
    category: 'trade', title: event.type.replaceAll('_', ' '), instrument: trade.instrument,
    timeframe: 'tick', price: event.price, reason: `${event.type.replaceAll('_', ' ')} at ${event.level}${event.target ? ` (${event.target})` : ''}. Compare with the manually configured trade and check the chart.`,
    suggestedAction: event.required ? 'Review the trade; if your plan requires an exit, act manually in MT5.' : 'Review your configured trade-management rules. This is an alert only.', href: '/trades',
  });
}

function safeExplanation(value, sourceNumbers) {
  if (!value || typeof value !== 'object') return false;
  const stringKeys = ['englishSummary', 'banglaExplanation'];
  const arrayKeys = ['confirmedFindings', 'hypotheses', 'conflicts', 'waitFor', 'dataLimitations'];
  if (![...stringKeys, ...arrayKeys].every((key) => Object.hasOwn(value, key))) return false;
  if (!stringKeys.every((key) => typeof value[key] === 'string' && value[key].length <= 1500)) return false;
  if (!arrayKeys.every((key) => Array.isArray(value[key]) && value[key].length <= 10 && value[key].every((item) => typeof item === 'string' && item.length <= 500))) return false;
  const strings = [...stringKeys.map((key) => value[key]), ...arrayKeys.flatMap((key) => value[key])].join(' ');
  const numbers = strings.match(/\d+(?:\.\d+)?/g) || [];
  return numbers.every((number) => sourceNumbers.has(number));
}

function makeApp() {
  const app = express();
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"],
    baseUri: ["'self'"], frameAncestors: ["'none'"],
    connectSrc: ["'self'", ...(process.env.NODE_ENV === 'production' ? ['wss:'] : ['ws:'])],
  } } }));
  app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true }));
  app.use(express.json({ limit: '5mb', strict: true }));
  app.use((req, res, next) => {
    const cookie = req.headers.cookie || '';
    req.cookies = Object.fromEntries(cookie.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('='); return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    }));
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/api/health', async (_req, res) => {
    const analysisUrl = process.env.ANALYSIS_URL || 'http://localhost:8001';
    let analysis = 'unavailable';
    try { const response = await fetch(`${analysisUrl}/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) analysis = 'healthy'; } catch {}
    res.json({ status: mongoose.connection.readyState === 1 && analysis === 'healthy' ? 'ok' : 'degraded', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', analysis, mode: DATA_MODE });
  });

  app.post('/api/auth/register', async (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ error: 'Registration is disabled' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Password must be 12 to 128 characters' });
    try {
      const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 12) });
      await UserSettings.create({ userId: user._id });
      await AuditLog.create({ userId: user._id, action: 'account.register', entity: 'User', entityId: user._id.toString() });
      setSession(res, user);
      res.status(201).json({ user: { id: user._id, email: user.email } });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'An account with that email already exists' });
      throw error;
    }
  });
  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect' });
    setSession(res, user);
    res.json({ user: { id: user._id, email: user.email } });
  });
  app.post('/api/auth/logout', (_req, res) => { res.clearCookie(ACCESS_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' }); res.status(204).end(); });
  app.get('/api/auth/me', authentication, async (req, res) => {
    const user = await User.findById(req.userId).select('email');
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.json({ user: { id: user._id, email: user.email } });
  });

  app.post('/api/collector/ingest', async (req, res) => {
    const configured = process.env.COLLECTOR_TOKEN || '';
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expectedBytes = Buffer.from(configured, 'utf8');
    const presentedBytes = Buffer.from(presented, 'utf8');
    if (configured.length < 32 || !/^[A-Za-z0-9._~-]+$/.test(presented) || presentedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(presentedBytes, expectedBytes)) return res.status(401).json({ error: 'Collector authentication failed' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Market-data storage is unavailable' });
    const payload = req.body;
    if (payload?.provider !== 'fundingpips-mt5' || typeof payload.symbol !== 'string' || payload.symbol.length > 40 || payload.symbol !== (process.env.MARKET_SYMBOL || 'XAUUSD') || typeof payload.accountServer !== 'string' || !payload.accountServer.trim() || payload.accountServer.length > 100 || !payload.timeframes || typeof payload.timeframes !== 'object') return res.status(400).json({ error: 'Invalid collector payload or unconfigured symbol/account server' });
    const now = new Date();
    const observedAt = new Date(payload.observedAt);
    if (!isUtcTimestamp(payload.observedAt) || observedAt > new Date(now.getTime() + 60_000)) return res.status(400).json({ error: 'Collector timestamp must be a UTC ISO-8601 instant' });
    const tickTime = new Date(payload.tick?.time);
    const bid = parseFinite(payload.tick?.bid, 'tick bid');
    const ask = parseFinite(payload.tick?.ask, 'tick ask');
    if (!isUtcTimestamp(payload.tick?.time) || tickTime > new Date(now.getTime() + 60_000) || ask < bid) return res.status(400).json({ error: 'Invalid UTC tick timestamp or bid/ask values' });
    const operations = [];
    let candlesAccepted = 0;
    const missingCandleGaps = {};
    for (const [timeframe, rows] of Object.entries(payload.timeframes)) {
      if (!TIMEFRAMES.has(timeframe) || !Array.isArray(rows) || rows.length > 2000) return res.status(400).json({ error: `Invalid candle set for ${timeframe}` });
      const seen = new Set();
      for (const raw of rows) {
        const bar = validateCandle(raw);
        if (!bar || bar.time > new Date(now.getTime() + 60_000) || seen.has(bar.time.getTime())) return res.status(400).json({ error: `Invalid or duplicate ${timeframe} candle` });
        seen.add(bar.time.getTime());
        operations.push({ updateOne: {
          filter: { provider: payload.provider, symbol: payload.symbol, timeframe, time: bar.time },
          update: { $set: { provider: payload.provider, symbol: payload.symbol, timeframe, ...bar } }, upsert: true,
        } });
        candlesAccepted += 1;
      }
      const sorted = [...rows].sort((a, b) => new Date(a.time) - new Date(b.time));
      missingCandleGaps[timeframe] = [];
      for (let index = 1; index < sorted.length; index += 1) {
        const delta = (new Date(sorted[index].time) - new Date(sorted[index - 1].time)) / 1000;
        if (delta > TIMEFRAME_SECONDS[timeframe] && delta <= Math.min(TIMEFRAME_SECONDS[timeframe] * 2, 8 * 3600)) missingCandleGaps[timeframe].push({ from: sorted[index - 1].time, to: sorted[index].time });
      }
    }
    if (!candlesAccepted) return res.status(400).json({ error: 'At least one candle is required for a heartbeat' });
    await MarketCandle.bulkWrite(operations, { ordered: false });
    await MarketSnapshot.updateOne({ provider: payload.provider, symbol: payload.symbol }, { $set: { provider: payload.provider, symbol: payload.symbol, time: tickTime, bid, ask, last: Number(payload.tick.last) || 0, observedAt } }, { upsert: true });
    const symbolInfo = payload.symbolInfo && typeof payload.symbolInfo === 'object' ? Object.fromEntries(['name', 'digits', 'point', 'tradeTickSize', 'tradeTickValue', 'contractSize', 'currencyBase', 'currencyProfit', 'currencyMargin', 'accountCurrency', 'volumeMin', 'volumeMax', 'volumeStep'].map((key) => [key, payload.symbolInfo[key]]).filter(([, value]) => value !== undefined)) : undefined;
    await CollectorState.updateOne({ provider: payload.provider }, { $set: { provider: payload.provider, symbol: payload.symbol, accountServer: payload.accountServer, status: 'connected', lastSeenAt: observedAt, lastTickAt: tickTime, terminalConnected: payload.terminalConnected === true, symbolInfo, missingCandleGaps, lastError: undefined } }, { upsert: true });
    const status = await marketStatus();
    if (status.isFresh) {
      const openTrades = await MonitoredTrade.find({ instrument: payload.symbol, status: 'open' }).lean();
      const settingsByUser = new Map();
      for (const trade of openTrades) {
        const userKey = trade.userId.toString();
        if (!settingsByUser.has(userKey)) settingsByUser.set(userKey, await UserSettings.findOne({ userId: trade.userId }).lean());
        const settings = settingsByUser.get(userKey);
        const distance = Math.abs(trade.entryPrice - trade.initialStopLoss) * 0.15;
        for (const event of tradeTriggers(trade, payload.tick, distance)) await createTradeAlert(trade, event, settings?.alertCooldownMinutes ?? 5);
      }
      global.marketBroadcast?.({ type: 'market', status });
    }
    res.json({ accepted: true, candlesAccepted, tickTime: tickTime.toISOString(), connectionStatus: status.connectionStatus, dataMode: DATA_MODE });
  });

  app.get('/api/market/status', authentication, async (_req, res) => res.json(await marketStatus()));
  app.get('/api/news', authentication, async (_req, res) => {
    const now = new Date();
    const events = await NewsEvent.find({ provider: NEWS_PROVIDER, scheduledAt: { $gte: new Date(now.getTime() - 7 * 86_400_000), $lte: new Date(now.getTime() + 30 * 86_400_000) } }).sort({ scheduledAt: 1 }).limit(200).lean();
    const providerState = process.env.TRADING_ECONOMICS_API_KEY ? await NewsProviderState.findOne({ provider: NEWS_PROVIDER }).lean() : null;
    res.json({ configured: Boolean(process.env.TRADING_ECONOMICS_API_KEY), provider: process.env.TRADING_ECONOMICS_API_KEY ? NEWS_PROVIDER : null, events, lastProviderUpdateAt: providerState?.lastSuccessfulAt || null, lastSyncAttemptAt: providerState?.lastAttemptAt || null, lastSyncError: providerState?.lastError || null });
  });
  app.get('/api/market/candles', authentication, async (req, res) => {
    const symbol = String(req.query.symbol || 'XAUUSD').toUpperCase();
    const timeframe = String(req.query.timeframe || 'M15').toUpperCase();
    if (!TIMEFRAMES.has(timeframe)) return res.status(400).json({ error: 'Unsupported timeframe' });
    const limit = Math.max(20, Math.min(1000, Number(req.query.limit) || 500));
    const candles = await candlesFor(timeframe, limit);
    const mode = await marketStatus();
    res.json({ symbol, timeframe, sourceMode: DATA_MODE, candles, connectionStatus: mode.connectionStatus, isFresh: mode.isFresh });
  });
  app.get('/api/backtesting/history', authentication, async (req, res) => {
    const runs = await BacktestRun.find({ userId: req.userId }).sort({ completedAt: -1 }).limit(20).lean();
    res.json({ runs });
  });
  app.post('/api/backtesting/run', authentication, async (req, res) => {
    if (DATA_MODE !== 'provider' || mongoose.connection.readyState !== 1) return res.status(409).json({ error: 'Backtesting requires stored candles from a configured provider; illustrative candles are not accepted.' });
    const timeframe = String(req.body?.timeframe || 'M15').toUpperCase();
    if (!TIMEFRAMES.has(timeframe)) return res.status(400).json({ error: 'Unsupported timeframe' });
    const limit = Math.floor(parseFinite(req.body?.limit ?? 2000, 'Candle limit', { min: 80, max: 5000 }));
    const strategy = ['breakout', 'retest'].includes(req.body?.strategy) ? req.body.strategy : null;
    if (!strategy) return res.status(400).json({ error: 'Strategy must be breakout or retest' });
    const config = {
      strategy,
      trainFraction: parseFinite(req.body?.trainFraction ?? 0.7, 'Train fraction', { min: 0.5, max: 0.9 }),
      stopAtr: parseFinite(req.body?.stopAtr ?? 1, 'Stop ATR', { min: 0.1, max: 10 }),
      rewardRisk: parseFinite(req.body?.rewardRisk ?? 2, 'Reward/risk', { min: 0.1, max: 10 }),
      spreadPrice: parseFinite(req.body?.spreadPrice ?? 0, 'Round-trip spread cost in price units', { max: 1000 }),
      slippagePrice: parseFinite(req.body?.slippagePrice ?? 0, 'Slippage per side in price units', { max: 1000 }),
      commissionPrice: parseFinite(req.body?.commissionPrice ?? 0, 'Round-trip commission in price units', { max: 1000 }),
    };
    const symbol = process.env.MARKET_SYMBOL || 'XAUUSD';
    const candles = await MarketCandle.find({ provider: 'fundingpips-mt5', symbol, timeframe }).sort({ time: -1 }).limit(limit).lean();
    candles.reverse();
    if (candles.length < 80) return res.status(409).json({ error: `At least 80 stored ${timeframe} provider candles are required; found ${candles.length}.` });
    const analysisUrl = process.env.ANALYSIS_URL || 'http://localhost:8001';
    const response = await fetch(`${analysisUrl}/backtest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, candles: candles.map((bar) => ({ time: bar.time.toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })) }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      const issue = await response.json().catch(() => ({}));
      return res.status(response.status === 400 ? 400 : 503).json({ error: issue.error || 'Backtest service is unavailable' });
    }
    const result = await response.json();
    const run = await BacktestRun.create({ userId: req.userId, strategy: { name: strategy, timeframe, ...result.configuration, ruleId: result.ruleId }, metrics: { train: result.train, outOfSample: result.outOfSample, bySession: result.bySession, byRegime: result.byRegime, sensitivityByRewardRisk: result.sensitivityByRewardRisk, limitations: result.limitations }, sourceRange: result.sourceRange, completedAt: new Date() });
    if (result.trades?.length) await BacktestTrade.insertMany(result.trades.map((trade) => ({ runId: run._id, entryAt: new Date(trade.entryAt), exitAt: new Date(trade.exitAt), side: trade.side, entry: trade.entry, exit: trade.exit, resultR: trade.resultR, setupType: trade.setupType, exitReason: trade.exitReason, session: trade.session, ruleId: trade.ruleId })));
    await AuditLog.create({ userId: req.userId, action: 'backtest.run', entity: 'BacktestRun', entityId: run._id.toString(), metadata: { timeframe, strategy, candleCount: candles.length } });
    res.status(201).json({ runId: run._id, ...result });
  });
  app.get('/api/market/analysis', authentication, async (req, res) => {
    try { res.json(await buildAnalysis(req.userId)); }
    catch (error) { if (error.status === 503 || error.name === 'TimeoutError') return res.status(503).json({ error: 'Analysis service is currently unavailable' }); throw error; }
  });
  app.post('/api/market/explain', authentication, async (req, res) => {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'AI explanations are not configured on the server' });
    const analysis = await buildAnalysis(req.userId);
    const safeInput = {
      sourceMode: analysis.sourceMode,
      timeframes: Object.fromEntries(Object.entries(analysis.report.timeframes).map(([tf, item]) => [tf, { role: item.role, status: item.status, regime: item.regime }])),
      events: Object.entries(analysis.results).flatMap(([tf, result]) => (result.structure || []).slice(-5).map((event) => ({ timeframe: tf, type: event.type, direction: event.direction, confirmed: event.confirmed }))),
      plan: { state: analysis.tradePlan.state, direction: analysis.tradePlan.direction, setupType: analysis.tradePlan.setupType || 'none', conditions: analysis.tradePlan.conditions || [], reasonsToAvoid: analysis.tradePlan.reasonsToAvoid || [] },
      newsFilterActive: Boolean(analysis.tradePlan.newsFilterActive), newsEvent: analysis.tradePlan.newsEvent || null,
      conflicts: analysis.report.explanations,
      dataWarnings: analysis.marketStatus.warnings,
    };
    const sourceNumbers = new Set((JSON.stringify(safeInput).match(/\d+(?:\.\d+)?/g) || []));
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-6-astra', store: false,
        input: [
          { role: 'system', content: 'Explain only the supplied deterministic market-analysis findings. Write a concise English summary and a simple Bangla explanation while retaining standard English trading terms. Distinguish confirmed findings from hypotheses. Explain conflicts and what condition the user should wait for. If data is illustrative, stale, insufficient, or missing, say that clearly. Do not create price levels, dates, news, indicators, historical statistics, risk changes, entries, exits, or trade instructions. Never change the deterministic plan state or risk rules. Output only the required JSON.' },
          { role: 'user', content: JSON.stringify(safeInput) },
        ],
        text: { format: { type: 'json_schema', name: 'market_explanation', strict: true, schema: openAiSchema } },
      }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return res.status(503).json({ error: 'AI explanation service returned an error' });
    const raw = await response.json();
    if (raw.status !== 'completed') return res.status(503).json({ error: 'AI explanation was incomplete or refused' });
    const output = (raw.output || []).flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    let explanation;
    try { explanation = JSON.parse(output); } catch { return res.status(502).json({ error: 'AI explanation failed schema validation' }); }
    if (!safeExplanation(explanation, sourceNumbers)) return res.status(502).json({ error: 'AI explanation failed server validation' });
    res.json({ sourceMode: analysis.sourceMode, explanation });
  });

  app.get('/api/trades', authentication, async (req, res) => {
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    const trades = await MonitoredTrade.find({ userId: req.userId, status }).sort({ openedAt: -1 }).lean();
    res.json({ trades });
  });
  app.post('/api/trades', authentication, async (req, res) => {
    const body = req.body || {};
    if (!['buy', 'sell'].includes(body.side)) return res.status(400).json({ error: 'Side must be Buy or Sell' });
    const entryPrice = parseFinite(body.entryPrice, 'Entry price', { min: Number.EPSILON });
    const positionSize = parseFinite(body.positionSize, 'Position size', { min: Number.EPSILON, max: 1000000 });
    const initialStopLoss = parseFinite(body.initialStopLoss, 'Initial stop loss', { min: Number.EPSILON });
    if ((body.side === 'buy' && initialStopLoss >= entryPrice) || (body.side === 'sell' && initialStopLoss <= entryPrice)) return res.status(400).json({ error: 'Stop loss must be on the risk side of the entry' });
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 5).map((target, index) => ({ label: String(target.label || `TP${index + 1}`).slice(0, 20), price: parseFinite(target.price, `TP${index + 1}`, { min: Number.EPSILON }) })) : [];
    if (targets.some((target) => body.side === 'buy' ? target.price <= entryPrice : target.price >= entryPrice)) return res.status(400).json({ error: 'Take-profit targets must be on the favorable side of entry' });
    const settings = await UserSettings.findOne({ userId: req.userId });
    if (!settings) return res.status(500).json({ error: 'User settings are unavailable' });
    const openTrades = await MonitoredTrade.find({ userId: req.userId }).sort({ closedAt: -1, openedAt: -1 }).limit(100).lean();
    const openCount = openTrades.filter((trade) => trade.status === 'open').length;
    const now = new Date();
    const currentDay = dateKey(now, settings.timezone || 'Asia/Dhaka');
    const todayCount = openTrades.filter((trade) => trade.createdAt && dateKey(new Date(trade.createdAt), settings.timezone || 'Asia/Dhaka') === currentDay).length;
    const currentSession = sessionKey(now);
    const sessionCount = openTrades.filter((trade) => trade.createdAt && sessionKey(new Date(trade.createdAt)) === currentSession).length;
    if (openCount >= settings.maxSimultaneousTrades) return res.status(409).json({ error: 'Configured maximum simultaneous trades has been reached' });
    if (todayCount >= settings.maxTradesPerDay) return res.status(409).json({ error: 'Configured maximum trades for the day has been reached' });
    if (sessionCount >= settings.maxSetupsPerSession) return res.status(409).json({ error: 'Configured maximum new setups for the current market session has been reached' });
    const previousClosures = openTrades.filter((trade) => trade.status === 'closed' && trade.closeOutcome).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
    let consecutiveLosses = 0;
    for (const trade of previousClosures) { if (trade.closeOutcome !== 'loss') break; consecutiveLosses += 1; }
    if (settings.maxConsecutiveLosses > 0 && consecutiveLosses >= settings.maxConsecutiveLosses) return res.status(409).json({ error: 'Configured consecutive-loss limit has been reached' });
    const lastLoss = previousClosures[0]?.closeOutcome === 'loss' ? previousClosures[0] : null;
    if (lastLoss && settings.cooldownMinutes > 0 && now - new Date(lastLoss.closedAt) < settings.cooldownMinutes * 60_000) return res.status(409).json({ error: 'Configured post-loss cooldown is still active' });
    const lossStatus = dailyLossLimitBreached(openTrades, settings, now);
    if (lossStatus.breached) return res.status(409).json({ error: 'Configured daily loss or drawdown limit has been reached' });
    const state = await CollectorState.findOne({ provider: 'fundingpips-mt5' }).lean();
    const risk = computeRisk(entryPrice, initialStopLoss, positionSize, state?.symbolInfo, settings);
    if (risk && risk.percentOfEquity > settings.maxRiskPercent) return res.status(409).json({ error: `Configured per-trade risk limit exceeded (${risk.percentOfEquity.toFixed(2)}% estimated)` });
    const trade = await MonitoredTrade.create({
      userId: req.userId, instrument: process.env.MARKET_SYMBOL || 'XAUUSD', side: body.side,
      entryPrice, positionSize, initialStopLoss, currentStopLoss: initialStopLoss, targets,
      thesis: String(body.thesis || '').slice(0, 2000), setupType: ['breakout', 'retest'].includes(body.setupType) ? body.setupType : 'other',
      strategyId: String(body.strategyId || '').slice(0, 100), openedAt: body.openedAt ? new Date(body.openedAt) : now,
      brokerPositionId: String(body.brokerPositionId || '').slice(0, 100),
    });
    await AuditLog.create({ userId: req.userId, action: 'trade.register', entity: 'MonitoredTrade', entityId: trade._id.toString(), metadata: { instrument: trade.instrument, side: trade.side } });
    res.status(201).json({ trade, estimatedRisk: risk, riskAvailable: Boolean(risk), riskNote: risk ? undefined : 'Monetary risk is unavailable until the collector reports verified symbol tick values/account currency and matching account equity is configured.' });
  });
  app.patch('/api/trades/:id/stop', authentication, async (req, res) => {
    const trade = await MonitoredTrade.findOne({ _id: req.params.id, userId: req.userId, status: 'open' });
    if (!trade) return res.status(404).json({ error: 'Open trade not found' });
    const stop = parseFinite(req.body?.currentStopLoss, 'Current stop loss', { min: Number.EPSILON });
    const tightens = trade.side === 'buy' ? stop >= trade.currentStopLoss : stop <= trade.currentStopLoss;
    if (!tightens) return res.status(400).json({ error: 'The tracking stop can only move toward profit or remain unchanged; it cannot be widened or removed' });
    trade.currentStopLoss = stop;
    await trade.save();
    await AuditLog.create({ userId: req.userId, action: 'trade.tracking_stop.update', entity: 'MonitoredTrade', entityId: trade._id.toString(), metadata: { currentStopLoss: stop, brokerModified: false } });
    res.json({ trade, brokerModified: false });
  });
  app.post('/api/trades/:id/close', authentication, async (req, res) => {
    const outcome = req.body?.outcome;
    if (!['win', 'loss', 'breakeven'].includes(outcome)) return res.status(400).json({ error: 'Outcome must be win, loss, or breakeven' });
    const trade = await MonitoredTrade.findOne({ _id: req.params.id, userId: req.userId, status: 'open' });
    if (!trade) return res.status(404).json({ error: 'Open trade not found' });
    const resultMoney = req.body?.resultMoney === undefined || req.body.resultMoney === '' ? undefined : Number(req.body.resultMoney);
    if (resultMoney !== undefined && !Number.isFinite(resultMoney)) return res.status(400).json({ error: 'Result amount must be a number' });
    if (outcome !== 'breakeven' && resultMoney === undefined) return res.status(400).json({ error: 'Enter the realized P/L so daily loss and drawdown checks remain meaningful' });
    if ((outcome === 'loss' && resultMoney > 0) || (outcome === 'win' && resultMoney < 0)) return res.status(400).json({ error: 'Recorded P/L sign must match the selected outcome' });
    trade.status = 'closed'; trade.closedAt = new Date(); trade.closeOutcome = outcome; trade.resultMoney = resultMoney;
    await trade.save();
    await AuditLog.create({ userId: req.userId, action: 'trade.close.record', entity: 'MonitoredTrade', entityId: trade._id.toString(), metadata: { outcome, resultMoney } });
    res.json({ trade, brokerModified: false });
  });

  app.get('/api/risk/status', authentication, async (req, res) => {
    const settings = await UserSettings.findOne({ userId: req.userId });
    const trades = await MonitoredTrade.find({ userId: req.userId }).limit(1000).lean();
    const key = dateKey(new Date(), settings.timezone || 'Asia/Dhaka');
    const today = trades.filter((trade) => trade.createdAt && dateKey(new Date(trade.createdAt), settings.timezone || 'Asia/Dhaka') === key);
    const loss = dailyLossLimitBreached(trades, settings);
    let consecutiveLosses = 0;
    for (const trade of trades.filter((item) => item.status === 'closed' && item.closeOutcome).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))) { if (trade.closeOutcome !== 'loss') break; consecutiveLosses += 1; }
    const setupsThisSession = trades.filter((trade) => trade.createdAt && sessionKey(new Date(trade.createdAt)) === sessionKey(new Date())).length;
    res.json({ configured: { maxRiskPercent: settings.maxRiskPercent, maxDailyLossPercent: settings.maxDailyLossPercent, maxTradesPerDay: settings.maxTradesPerDay, maxConsecutiveLosses: settings.maxConsecutiveLosses, maxDailyDrawdownPercent: settings.maxDailyDrawdownPercent, maxSimultaneousTrades: settings.maxSimultaneousTrades, cooldownMinutes: settings.cooldownMinutes, alertCooldownMinutes: settings.alertCooldownMinutes, maxSetupsPerSession: settings.maxSetupsPerSession },
      tradesToday: today.length, setupsThisSession, activeTrades: trades.filter((trade) => trade.status === 'open').length, consecutiveLosses,
      realizedLossToday: loss.realizedLoss, realizedDrawdownToday: loss.maxDrawdownAmount || 0, riskAvailable: loss.available, limitsBreached: loss.breached,
      note: 'Limits gate new trade records inside this app only. They are not broker-side restrictions; unrecorded trades and external P/L are not included.' });
  });
  app.post('/api/risk/position-size', authentication, async (req, res) => {
    const entry = parseFinite(req.body?.entryPrice, 'Entry price', { min: Number.EPSILON });
    const stop = parseFinite(req.body?.stopLoss, 'Stop loss', { min: Number.EPSILON });
    if (entry === stop) return res.status(400).json({ error: 'Entry and stop loss must differ' });
    const [settings, state] = await Promise.all([UserSettings.findOne({ userId: req.userId }), CollectorState.findOne({ provider: 'fundingpips-mt5' }).lean()]);
    const status = await marketStatus();
    if (DATA_MODE !== 'provider' || !status.isFresh) return res.status(409).json({ error: 'Position-size guidance requires a fresh verified provider feed' });
    if (!settings?.accountEquity || !settings.accountCurrency || settings.accountCurrency !== state?.symbolInfo?.accountCurrency) return res.status(409).json({ error: 'Set account equity and match the verified MT5 account currency first' });
    const oneLotRisk = computeRisk(entry, stop, 1, state.symbolInfo, settings);
    const step = Number(state.symbolInfo?.volumeStep);
    const min = Number(state.symbolInfo?.volumeMin);
    const max = Number(state.symbolInfo?.volumeMax);
    if (!oneLotRisk || !Number.isFinite(step) || step <= 0 || !Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return res.status(409).json({ error: 'Verified tick and volume specifications are unavailable' });
    const maxMoneyRisk = settings.accountEquity * settings.maxRiskPercent / 100;
    const rawSize = maxMoneyRisk / oneLotRisk.amount;
    const size = Math.min(max, Math.floor(rawSize / step) * step);
    if (size < min) return res.status(409).json({ error: 'The configured risk limit implies a size below the broker minimum; no size is suggested' });
    const estimatedRisk = computeRisk(entry, stop, size, state.symbolInfo, settings);
    res.json({ positionSize: Number(size.toFixed(8)), estimatedRisk, riskLimitPercent: settings.maxRiskPercent, brokerMinimum: min, brokerMaximum: max, volumeStep: step, source: 'MT5 symbol specifications and manually configured equity' });
  });

  app.get('/api/settings', authentication, async (req, res) => {
    const settings = await UserSettings.findOne({ userId: req.userId }).select('+telegramChatId');
    const safe = settings?.toObject() || null;
    const telegramConfigured = Boolean(safe?.telegramChatId);
    if (safe) delete safe.telegramChatId;
    res.json({ settings: safe, telegramConfigured });
  });
  app.patch('/api/settings', authentication, async (req, res) => {
    const editable = ['timezone', 'accountEquity', 'accountCurrency', 'maxRiskPercent', 'maxDailyLossPercent', 'maxTradesPerDay', 'maxConsecutiveLosses', 'maxDailyDrawdownPercent', 'maxSimultaneousTrades', 'cooldownMinutes', 'alertCooldownMinutes', 'maxSetupsPerSession', 'newsFilterEnabled', 'newsMinutesBefore', 'newsMinutesAfter', 'telegramChatId', 'telegramEnabled', 'quietHours', 'notificationCategories'];
    const update = {};
    for (const key of editable) if (Object.hasOwn(req.body || {}, key)) update[key] = req.body[key];
    if (update.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: update.timezone }); } catch { return res.status(400).json({ error: 'Unknown timezone' }); } }
    if (update.accountEquity !== undefined) update.accountEquity = parseFinite(update.accountEquity || 0, 'Account equity');
    if (update.accountCurrency !== undefined) update.accountCurrency = String(update.accountCurrency || '').toUpperCase().slice(0, 10);
    for (const key of ['maxRiskPercent', 'maxDailyLossPercent', 'maxDailyDrawdownPercent']) if (update[key] !== undefined) update[key] = parseFinite(update[key], key, { max: 100 });
    for (const key of ['maxTradesPerDay', 'maxConsecutiveLosses', 'maxSimultaneousTrades', 'cooldownMinutes', 'alertCooldownMinutes', 'maxSetupsPerSession']) if (update[key] !== undefined) update[key] = parseFinite(update[key], key, { max: 10080 });
    for (const key of ['newsMinutesBefore', 'newsMinutesAfter']) if (update[key] !== undefined) update[key] = parseFinite(update[key], key, { max: 1440 });
    if (update.telegramChatId !== undefined) update.telegramChatId = String(update.telegramChatId).trim().slice(0, 64);
    if (update.telegramEnabled !== undefined) update.telegramEnabled = Boolean(update.telegramEnabled);
    if (update.newsFilterEnabled !== undefined) update.newsFilterEnabled = Boolean(update.newsFilterEnabled);
    if (update.notificationCategories !== undefined) update.notificationCategories = Array.isArray(update.notificationCategories) ? [...new Set(update.notificationCategories.filter((item) => ['trade', 'data', 'system', 'news'].includes(item)))] : [];
    if (update.quietHours !== undefined) {
      const { start, end } = update.quietHours || {};
      if ((start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) || (end && !/^([01]\d|2[0-3]):[0-5]\d$/.test(end))) return res.status(400).json({ error: 'Quiet hours must use HH:MM in the selected timezone' });
    }
    const settings = await UserSettings.findOneAndUpdate({ userId: req.userId }, { $set: update }, { new: true, runValidators: true });
    await AuditLog.create({ userId: req.userId, action: 'settings.update', entity: 'UserSettings', entityId: settings._id.toString(), metadata: { changedFields: Object.keys(update).filter((key) => key !== 'telegramChatId') } });
    res.json({ settings });
  });
  app.post('/api/settings/test-telegram', authentication, async (req, res) => {
    const settings = await UserSettings.findOne({ userId: req.userId }).select('+telegramChatId');
    if (!settings?.telegramEnabled || !settings.telegramChatId || !process.env.TELEGRAM_BOT_TOKEN) return res.status(400).json({ error: 'Enable Telegram and configure the server bot token and chat ID first' });
    const alert = await AlertEvent.create({ userId: req.userId, eventKey: `telegram-test:${crypto.randomUUID()}`, category: 'system', title: 'Telegram test notification', instrument: 'XAUUSD', reason: 'Telegram delivery was manually tested from settings.' });
    const delivery = await NotificationDelivery.create({ userId: req.userId, alertId: alert._id, channel: 'telegram', status: 'pending', attempts: 0 });
    try {
      await sendTelegram(settings.telegramChatId, 'AI Trading Intelligence: Telegram notification test.');
      delivery.status = 'delivered'; delivery.attempts = 1; delivery.deliveredAt = new Date(); await delivery.save();
      res.json({ sent: true, status: delivery.status });
    } catch {
      delivery.status = 'failed'; delivery.attempts = 1; delivery.lastError = 'Telegram test delivery failed'; await delivery.save();
      res.status(502).json({ sent: false, status: delivery.status });
    }
  });

  app.get('/api/alerts', authentication, async (req, res) => {
    const alerts = await AlertEvent.find({ userId: req.userId }).sort({ triggeredAt: -1 }).limit(100).lean();
    const ids = alerts.map((alert) => alert._id);
    const deliveries = await NotificationDelivery.find({ alertId: { $in: ids }, userId: req.userId }).lean();
    res.json({ alerts, deliveries });
  });
  app.get('/api/journal', authentication, async (req, res) => {
    const entries = await mongoose.model('TradingJournalEntry').find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ entries });
  });
  app.post('/api/journal', authentication, async (req, res) => {
    const notes = String(req.body?.notes || '').trim();
    if (!notes || notes.length > 5000) return res.status(400).json({ error: 'Journal notes must be between 1 and 5000 characters' });
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((tag) => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 12) : [];
    const entry = await mongoose.model('TradingJournalEntry').create({ userId: req.userId, tradeId: req.body?.tradeId || undefined, notes, tags });
    await AuditLog.create({ userId: req.userId, action: 'journal.entry.create', entity: 'TradingJournalEntry', entityId: entry._id.toString() });
    res.status(201).json({ entry });
  });
  app.delete('/api/journal/:id', authentication, async (req, res) => {
    const entry = await mongoose.model('TradingJournalEntry').findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });
    await AuditLog.create({ userId: req.userId, action: 'journal.entry.delete', entity: 'TradingJournalEntry', entityId: entry._id.toString() });
    res.status(204).end();
  });
  app.get('/api/unavailable/:module', authentication, (req, res) => {
    const module = String(req.params.module || '').slice(0, 40);
    res.json({ status: 'unavailable', module, message: `${module} is not enabled because a verified provider or documented rule set is not configured.` });
  });

  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || (error.name === 'ValidationError' ? 400 : 500);
    if (status >= 500) console.error('request_failed', { status, name: error.name || 'Error' });
    res.status(status).json({ error: status >= 500 ? 'Request could not be completed' : error.message });
  });
  return app;
}

module.exports = { makeApp, authentication, authToken, marketStatus, buildAnalysis, DATA_MODE, computeRisk, dateKey, sessionKey, dailyLossLimitBreached, safeExplanation, JWT_SECRET };
