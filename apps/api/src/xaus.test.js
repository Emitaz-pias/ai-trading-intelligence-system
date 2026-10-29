const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeXausPayload, TIMEFRAME_CONFIG } = require('./xaus');

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
