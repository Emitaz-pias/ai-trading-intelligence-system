const TIMEFRAMES = new Set(['M5', 'M15', 'M30', 'H1', 'H4', 'D1']);

function isFresh(now, timestamp, maxAgeSeconds) {
  if (!timestamp) return false;
  const age = (new Date(now).getTime() - new Date(timestamp).getTime()) / 1000;
  return Number.isFinite(age) && age >= -5 && age <= maxAgeSeconds;
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  const fields = value.slice(0, 19).split(/[-T:]/).map(Number);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === fields[0] && date.getUTCMonth() + 1 === fields[1] && date.getUTCDate() === fields[2] && date.getUTCHours() === fields[3] && date.getUTCMinutes() === fields[4] && date.getUTCSeconds() === fields[5];
}

function validateCandle(candle) {
  if (!isUtcTimestamp(candle?.time)) return false;
  const time = new Date(candle?.time);
  const values = ['open', 'high', 'low', 'close'].map((key) => Number(candle?.[key]));
  const [open, high, low, close] = values;
  if (!Number.isFinite(time.getTime()) || !values.every(Number.isFinite) ||
      low > Math.min(open, close) || high < Math.max(open, close) || low > high) return false;
  return { time, open, high, low, close, volume: Math.max(0, Number(candle.volume) || 0) };
}

function candleGapCandidates(candles, seconds) {
  const sorted = [...candles].sort((a, b) => new Date(a.time) - new Date(b.time));
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = (new Date(sorted[i].time) - new Date(sorted[i - 1].time)) / 1000;
    if (delta > seconds && delta <= Math.min(seconds * 2, 8 * 3600)) gaps.push({ from: sorted[i - 1].time, to: sorted[i].time });
  }
  return gaps;
}

function tradeTriggers(trade, tick, alertDistance) {
  if (!trade || trade.status !== 'open' || !tick) return [];
  const price = trade.side === 'buy' ? tick.bid : tick.ask;
  if (!Number.isFinite(price)) return [];
  const hits = [];
  const stopHit = trade.side === 'buy' ? price <= trade.currentStopLoss : price >= trade.currentStopLoss;
  if (stopHit) hits.push({ type: 'STOP_LOSS_REACHED', key: `stop:${trade.currentStopLoss}`, level: trade.currentStopLoss, required: true });
  else if (Math.abs(price - trade.currentStopLoss) <= alertDistance) hits.push({ type: 'STOP_APPROACHING', key: `stop-near:${trade.currentStopLoss}`, level: trade.currentStopLoss, required: false });
  for (const target of trade.targets || []) {
    if (target.reachedAt) continue;
    const reached = trade.side === 'buy' ? price >= target.price : price <= target.price;
    const distance = Math.abs(price - target.price);
    if (reached) hits.push({ type: 'TAKE_PROFIT_REACHED', key: `target:${target.label}:${target.price}`, level: target.price, required: false, target: target.label });
    else if (distance <= alertDistance) hits.push({ type: 'TAKE_PROFIT_APPROACHING', key: `target-near:${target.label}:${target.price}`, level: target.price, required: false, target: target.label });
  }
  return hits.map((hit) => ({ ...hit, price, instrument: trade.instrument }));
}

function makeConditionalPlan(result, healthy, sourceMode, candles = {}) {
  const m15 = result?.results?.M15;
  if (sourceMode === 'xaus') return {
    state: 'NO_TRADE', direction: 'unknown', ruleId: 'indicative-reference-feed-no-entry-v1', conditions: [],
    reasonsToAvoid: [
      ...(!healthy ? ['The latest completed M5 reference candle is stale; current trade conditions are withheld.'] : []),
      ...(!m15 || m15.status !== 'ok' ? ['There are not enough completed M15 candles for confirmed structure.'] : []),
      'The chart analysis uses an indicative XAU/USD reference feed, not your broker quote.',
      'Broker spread, execution conditions, upcoming news and account-specific risk are not verified.',
    ],
    explanation: 'Structure and zones are displayed for context. No entry conditions are issued from this reference feed.',
  };
  if (!healthy || !m15 || m15.status !== 'ok') {
    return { state: 'DATA_UNAVAILABLE', direction: 'unknown', ruleId: 'data-freshness-gate-v1', conditions: [], reasonsToAvoid: ['A verified, fresh provider feed and enough closed M15 candles are required before any live plan can be considered.'], explanation: 'No actionable plan is available from illustrative or stale data.' };
  }
  if (sourceMode !== 'provider') return { state: 'DATA_UNAVAILABLE', direction: 'unknown', ruleId: 'data-freshness-gate-v1', conditions: [], reasonsToAvoid: ['A verified, fresh provider feed is required before any live plan can be considered.'], explanation: 'No actionable plan is available from illustrative or stale data.' };
  const latestBreak = [...(m15.structure || [])].reverse().find((event) => event.confirmed && ['BOS', 'CHOCH'].includes(event.type));
  const current = m15.currentClose;
  if (!latestBreak) {
    const resistance = m15.nearestResistance;
    const support = m15.nearestSupport;
    return {
      state: 'WAITING_FOR_SETUP', direction: m15.regime === 'bullish_trend' ? 'bullish' : m15.regime === 'bearish_trend' ? 'bearish' : 'undetermined',
      setupType: 'breakout', timeframe: 'M15', lastClosedClose: current, relevantZone: resistance || support || null,
      conditions: [`Wait for a completed M15 candle to close beyond a confirmed swing level${resistance ? ` (resistance zone ${resistance.low}–${resistance.high})` : ''}.`, 'A wick through the level alone does not confirm a break.', 'Reassess after the close; do not enter on this plan state.'],
      invalidation: resistance ? `A close back below ${resistance.low} invalidates an upside-break hypothesis.` : support ? `A close back above ${support.high} invalidates a downside-break hypothesis.` : 'No level is available to define invalidation.',
      reasonsToAvoid: ['No close-confirmed M15 structure break is present.', 'Mixed structure or an upcoming event may make the setup unsuitable.'],
      ruleId: 'wait-for-close-confirmed-break-v1',
    };
  }
  const direction = latestBreak.direction === 'up' ? 'bullish' : 'bearish';
  const m15Bars = candles.M15 || [];
  const breakIndex = m15Bars.findIndex((bar) => new Date(bar.time).getTime() === new Date(latestBreak.time).getTime());
  const barsAfterBreak = breakIndex >= 0 ? m15Bars.slice(breakIndex + 1) : [];
  if (breakIndex < 0 || barsAfterBreak.length > 8) {
    return { state: 'WAITING_FOR_SETUP', direction: m15.regime === 'bullish_trend' ? 'bullish' : m15.regime === 'bearish_trend' ? 'bearish' : 'undetermined', setupType: 'breakout', timeframe: 'M15', lastClosedClose: current, conditions: ['No close-confirmed structure break occurred within the last eight completed M15 bars.', 'Wait for a new close beyond a confirmed swing.'], reasonsToAvoid: ['The most recent structure break is outside the configured retest window.'], ruleId: 'break-expiry-after-eight-m15-bars-v1' };
  }
  const retestZone = Math.max((m15.atr14 || 0) * 0.25, 0.01);
  if (barsAfterBreak.length === 0) {
    const lower = latestBreak.level - retestZone;
    const upper = latestBreak.level + retestZone;
    return {
      state: 'ENTRY_CONDITIONS_MET', direction, setupType: 'breakout', timeframe: 'M15', lastClosedClose: current,
      relevantZone: { low: lower, high: upper, mid: latestBreak.level, type: 'breakout-level', sourceEvent: latestBreak.type },
      conditions: [`A completed M15 candle closed ${direction === 'bullish' ? 'above' : 'below'} the confirmed ${latestBreak.type} level ${latestBreak.level}.`, 'This is a close-confirmed breakout hypothesis; the next candle may gap or reverse.', 'Review the higher-timeframe context, upcoming event risk, spread and configured account risk before deciding. The system does not place an order.'],
      invalidation: direction === 'bullish' ? `A later M15 close below ${lower.toFixed(2)} weakens this breakout interpretation.` : `A later M15 close above ${upper.toFixed(2)} weakens this breakout interpretation.`,
      reasonsToAvoid: ['A wick through the level alone is not confirmation.', 'A confirmed close does not guarantee continuation.', 'No stop, target, or risk/reward is proposed without the full contract and account context.'],
      breakoutEvent: latestBreak, ruleId: 'close-confirmed-breakout-next-bar-review-v1',
    };
  }
  const lower = latestBreak.level - retestZone;
  const upper = latestBreak.level + retestZone;
  const rejection = (bar) => direction === 'bullish'
    ? bar.low >= lower && bar.low <= upper && bar.close > latestBreak.level && bar.close > bar.open
    : bar.high <= upper && bar.high >= lower && bar.close < latestBreak.level && bar.close < bar.open;
  const retestIndex = barsAfterBreak.findIndex(rejection);
  const retestBar = retestIndex >= 0 ? barsAfterBreak[retestIndex] : null;
  const invalidated = retestBar && barsAfterBreak.slice(retestIndex + 1).some((bar) => direction === 'bullish' ? bar.close < lower : bar.close > upper);
  const preRetestInvalidation = !retestBar && barsAfterBreak.some((bar) => direction === 'bullish' ? bar.close < lower : bar.close > upper);
  if (invalidated || preRetestInvalidation) {
    return { state: 'SETUP_INVALIDATED', direction, setupType: 'retest', timeframe: 'M15', lastClosedClose: current, relevantZone: { low: lower, high: upper, mid: latestBreak.level, type: 'break-retest' }, conditions: ['A completed M15 close crossed the far edge of the defined retest zone.'], invalidation: direction === 'bullish' ? `An M15 close below ${lower.toFixed(2)} invalidates this bullish retest.` : `An M15 close above ${upper.toFixed(2)} invalidates this bearish retest.`, reasonsToAvoid: ['The latest close invalidated this setup hypothesis.'], breakoutEvent: latestBreak, ruleId: 'close-break-retest-invalidation-v1' };
  }
  const m5 = (candles.M5 || []).at(-1);
  const m5Confirmed = Boolean(retestBar && m5 && new Date(m5.time) > new Date(retestBar.time) && (direction === 'bullish' ? m5.close > retestBar.high : m5.close < retestBar.low));
  return {
    state: m5Confirmed ? 'ENTRY_CONDITIONS_MET' : retestBar ? 'SETUP_CONFIRMED' : 'WAITING_FOR_CONFIRMATION', direction, setupType: 'retest', timeframe: 'M15',
    lastClosedClose: current, relevantZone: { low: lower, high: upper, mid: latestBreak.level, type: 'break-retest', sourceEvent: latestBreak.type },
    conditions: [`M15 ${latestBreak.type} close at ${latestBreak.level} was recorded at ${latestBreak.time}.`, `Retest zone is ${lower.toFixed(2)}–${upper.toFixed(2)} using 0.25 × ATR(14).`, 'Confirmation requires a completed M15 rejection candle inside the zone that closes back in the breakout direction.', retestBar ? 'M15 retest/rejection is confirmed; wait for a completed M5 close beyond the rejection candle extreme.' : 'No qualifying closed M15 rejection candle is present yet.', m5Confirmed ? 'M5 closed beyond the M15 rejection candle extreme; entry conditions are met under this rule only.' : 'This application only alerts; the user decides and places any trade manually.'],
    invalidation: direction === 'bullish' ? `An M15 close below ${lower.toFixed(2)} invalidates this retest interpretation.` : `An M15 close above ${upper.toFixed(2)} invalidates this retest interpretation.`,
    reasonsToAvoid: ['The break may fail or reverse.', 'The current rule does not include spread, slippage, news, or account risk capacity.', 'No stop/target is proposed without a verified contract specification and complete risk context.'],
    breakoutEvent: latestBreak, rejectionCandleTime: retestBar?.time || null, ruleId: 'close-break-atr-retest-m5-confirm-v2',
  };
}

module.exports = { TIMEFRAMES, isFresh, isUtcTimestamp, validateCandle, candleGapCandidates, tradeTriggers, makeConditionalPlan };
