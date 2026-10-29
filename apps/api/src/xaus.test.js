const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeXausPayload, TIMEFRAME_CONFIG, fetchXausSpot, clearXausCache } = require('./xaus');

test('XAUS candles keep only valid completed UTC bars and never imply spot volume', () => {
  const now = Date.parse('2026-01-01T00:06:00Z');
  const payload = {
    symbol: 'xau',
    points: [
      { t: Date.parse('2026-01-01T00:00:00Z') / 1000, o: 10, h: 12, l: 9, c: 11, v: 400 },
      { t: Date.parse('2026-01-01T00:05:00Z') / 1000, o: 11, h: 13, l: 10, c: 12, v: 500 },
      { t: Date.parse('2026-01-01T00:00:00Z') / 1000, o: 10, h: 12, l: 9, c: 11, v: 600 },
      { t: Date.parse('2026-01-01T00:00:00Z') / 1000, o: 10, h: null, l: 9, c: 11 },
    ],
  };
  const bars = normalizeXausPayload(payload, 'M5', now);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].time, '2026-01-01T00:00:00.000Z');
  assert.equal(bars[0].volume, 0);
  assert.equal(bars[0].source, 'xaus-yahoo-proxy');
});

test('XAUS maps each configured analysis timeframe to a published OHLC interval', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TIMEFRAME_CONFIG).map(([timeframe, config]) => [timeframe, config.interval])), {
    M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '4h', D1: '1d',
  });
});

test('XAUS spot quote exposes only fresh sourced prices and caches for one minute', async () => {
  clearXausCache();
  const nowMs = Date.parse('2026-01-01T00:01:00Z');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ spot_usd_oz: 4000, price_as_of: '2026-01-01T00:01:00Z', price_source: 'gold-api.com', data_state: { status: 'fresh', age_seconds: 0 } }) };
  };
  const first = await fetchXausSpot({ nowMs, fetchImpl });
  const cached = await fetchXausSpot({ nowMs: nowMs + 30_000, fetchImpl });
  assert.equal(first.price, 4000);
  assert.equal(first.source, 'gold-api.com');
  assert.equal(first.status, 'fresh');
  assert.equal(cached.checkedAt, first.checkedAt);
  assert.equal(calls, 1);

  clearXausCache();
  const stale = await fetchXausSpot({ nowMs, fetchImpl: async () => ({ ok: true, json: async () => ({ spot_usd_oz: 4000, price_as_of: '2025-12-31T23:00:00Z', price_source: 'gold-api.com', stale: true, data_state: { status: 'stale', age_seconds: 3600 } }) }) });
  assert.equal(stale.price, null);
  assert.equal(stale.status, 'stale');
  clearXausCache();
});
