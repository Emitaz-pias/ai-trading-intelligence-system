const SECONDS = { M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const END = Date.parse('2025-01-10T20:00:00.000Z');

// Deterministic synthetic bars for UI and rule-engine development only.
// These values are not retrieved from a broker and must never be treated as market prices.
function illustrativeCandles(timeframe, limit = 500) {
  const interval = SECONDS[timeframe];
  if (!interval) return [];
  const count = Math.min(1000, Math.max(20, Number(limit) || 500));
  const rows = [];
  let prior = 2648.5;
  const end = Math.floor(END / (interval * 1000)) * interval * 1000;
  for (let i = count - 1; i >= 0; i -= 1) {
    const idx = count - 1 - i;
    const cyclical = Math.sin(idx * 0.13) * 2.3 + Math.sin(idx * 0.037) * 4.1;
    const drift = Math.sin(idx * 0.008) * 0.055;
    const close = 2648.5 + cyclical + idx * drift;
    const open = prior;
    const wick = 0.35 + Math.abs(Math.sin(idx * 1.7)) * 1.2;
    rows.push({
      time: new Date(end - i * interval * 1000).toISOString(), open: Number(open.toFixed(2)),
      high: Number((Math.max(open, close) + wick).toFixed(2)), low: Number((Math.min(open, close) - wick * 0.9).toFixed(2)),
      close: Number(close.toFixed(2)), volume: Math.round(100 + Math.abs(Math.sin(idx * 0.21)) * 850),
      source: 'illustrative',
    });
    prior = close;
  }
  return rows;
}

module.exports = { illustrativeCandles };
