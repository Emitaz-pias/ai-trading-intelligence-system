const test = require('node:test');
const assert = require('node:assert/strict');
const { isFresh, validateCandle, isUtcTimestamp, tradeTriggers, makeConditionalPlan } = require('./rules');
const { sessionKey, dailyLossLimitBreached } = require('./risk');

test('freshness rejects missing and stale timestamps', () => {
  const now = new Date('2025-01-01T00:00:30Z');
  assert.equal(isFresh(now, '2025-01-01T00:00:00Z', 60), true);
  assert.equal(isFresh(now, '2024-12-31T23:50:00Z', 60), false);
  assert.equal(isFresh(now, null, 60), false);
});

test('candle validation checks OHLC bounds and UTC parseability', () => {
  assert.ok(validateCandle({ time: '2025-01-01T00:00:00Z', open: 1, high: 3, low: 0, close: 2 }));
  assert.equal(validateCandle({ time: '2025-01-01T00:00:00Z', open: 1, high: 0, low: 0, close: 2 }), false);
  assert.equal(validateCandle({ time: '2025-01-01T00:00:00', open: 1, high: 3, low: 0, close: 2 }), false);
  assert.equal(validateCandle({ time: '2025-02-30T00:00:00Z', open: 1, high: 3, low: 0, close: 2 }), false);
  assert.equal(isUtcTimestamp('2025-01-01T00:00:00+01:00'), false);
});

test('trade monitor produces price triggers but never an execution instruction', () => {
  const trade = { status: 'open', side: 'buy', instrument: 'XAUUSD', currentStopLoss: 2640, targets: [{ label: 'TP1', price: 2700 }] };
  const hits = tradeTriggers(trade, { bid: 2639.9, ask: 2640.1 }, 2);
  assert.equal(hits[0].type, 'STOP_LOSS_REACHED');
  assert.equal(hits[0].required, true);
});

test('illustrative and stale sources cannot produce an actionable plan', () => {
  assert.equal(makeConditionalPlan({ results: {} }, true, 'illustrative').state, 'DATA_UNAVAILABLE');
  assert.equal(makeConditionalPlan({ results: {} }, false, 'provider').state, 'DATA_UNAVAILABLE');
});

test('fresh indicative XAUS candles may show chart analysis but never issue a trade entry', () => {
  const current = bar(0, 99, 101, 98, 100);
  const plan = makeConditionalPlan(planFixture([current]), true, 'xaus', { M15: [current] });
  assert.equal(plan.state, 'NO_TRADE');
  assert.match(plan.reasonsToAvoid.join(' '), /broker quote/);
  const stalePlan = makeConditionalPlan(planFixture([current]), false, 'xaus', { M15: [current] });
  assert.equal(stalePlan.state, 'NO_TRADE');
  assert.match(stalePlan.reasonsToAvoid.join(' '), /stale/);
});

function planFixture(m15Bars, m5Bars = []) {
  return {
    results: { M15: { status: 'ok', regime: 'bullish_trend', currentClose: m15Bars.at(-1).close, atr14: 1, structure: [{ type: 'BOS', direction: 'up', level: 100, time: m15Bars[0].time, confirmed: true }] } },
  };
}
const time = (minutes) => new Date(Date.parse('2025-01-01T00:00:00Z') + minutes * 60_000).toISOString();
const bar = (minutes, open, high, low, close) => ({ time: time(minutes), open, high, low, close });

test('retest plan waits for a closed M15 rejection and then M5 confirmation', () => {
  const breakout = bar(0, 99, 101, 98, 101);
  const noRetest = bar(15, 101, 103, 101, 102);
  assert.equal(makeConditionalPlan(planFixture([breakout, noRetest]), true, 'provider', { M15: [breakout, noRetest] }).state, 'WAITING_FOR_CONFIRMATION');

  const rejection = bar(15, 99.8, 100.5, 100, 100.4);
  const confirmed = planFixture([breakout, rejection]);
  assert.equal(makeConditionalPlan(confirmed, true, 'provider', { M15: [breakout, rejection], M5: [bar(20, 100.3, 100.5, 100.2, 100.4)] }).state, 'SETUP_CONFIRMED');
  assert.equal(makeConditionalPlan(confirmed, true, 'provider', { M15: [breakout, rejection], M5: [bar(25, 100.4, 100.8, 100.4, 100.7)] }).state, 'ENTRY_CONDITIONS_MET');
});

test('a fresh close-confirmed break exposes the separate breakout setup state', () => {
  const breakout = bar(0, 99, 101, 98, 101);
  const result = planFixture([breakout]);
  const plan = makeConditionalPlan(result, true, 'provider', { M15: [breakout] });
  assert.equal(plan.state, 'ENTRY_CONDITIONS_MET');
  assert.equal(plan.setupType, 'breakout');
  assert.match(plan.invalidation, /later M15 close/);
});

test('a close beyond the retest invalidation boundary invalidates the plan', () => {
  const breakout = bar(0, 99, 101, 98, 101);
  const failure = bar(15, 100, 100.1, 98.5, 98.8);
  const result = planFixture([breakout, failure]);
  assert.equal(makeConditionalPlan(result, true, 'provider', { M15: [breakout, failure] }).state, 'SETUP_INVALIDATED');
});

test('session keys follow IANA daylight-saving windows and distinguish overlap', () => {
  assert.match(sessionKey(new Date('2025-03-30T08:30:00Z')), /^london:/);
  assert.match(sessionKey(new Date('2025-07-01T13:00:00Z')), /^london_new_york_overlap:/);
  assert.match(sessionKey(new Date('2025-07-01T17:00:00Z')), /^asia:/);
});

test('realized net loss and intraday peak drawdown are both evaluated', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const settings = { accountEquity: 1000, maxDailyLossPercent: 1, maxDailyDrawdownPercent: 0.5, timezone: 'Asia/Dhaka' };
  const result = dailyLossLimitBreached([
    { status: 'closed', closedAt: new Date('2026-10-24T08:00:00Z'), resultMoney: 10 },
    { status: 'closed', closedAt: new Date('2026-10-24T09:00:00Z'), resultMoney: -15 },
  ], settings, now);
  assert.equal(result.realizedLoss, -5);
  assert.equal(result.maxDrawdownAmount, 15);
  assert.equal(result.breached, true);
});
