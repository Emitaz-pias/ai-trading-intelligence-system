const TIMEFRAME_CONFIG = {
  M5: { interval: '5m', range: '5d', seconds: 5 * 60 },
  M15: { interval: '15m', range: '1mo', seconds: 15 * 60 },
  M30: { interval: '30m', range: '1mo', seconds: 30 * 60 },
  H1: { interval: '1h', range: '1y', seconds: 60 * 60 },
  H4: { interval: '4h', range: '5y', seconds: 4 * 60 * 60 },
  D1: { interval: '1d', range: '5y', seconds: 24 * 60 * 60 },
};

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function normalizeXausPayload(payload, timeframe, nowMs = Date.now()) {
  const config = TIMEFRAME_CONFIG[timeframe];
  if (!config) throw new Error('Unsupported XAU/USD timeframe');
  if (payload?.symbol !== 'xau' || !Array.isArray(payload.points)) throw new Error('XAU/USD data provider returned an invalid response');

  const candles = new Map();
  for (const point of payload.points) {
    const timestamp = Number(point?.t);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const time = new Date(timestamp * 1000);
    if (['o', 'h', 'l', 'c'].some((field) => point?.[field] === null || point?.[field] === undefined || point?.[field] === '')) continue;
    const values = ['o', 'h', 'l', 'c'].map((field) => Number(point?.[field]));
    const [open, high, low, close] = values;
    if (!Number.isFinite(time.getTime()) || time.getTime() > nowMs + 60_000 ||
      !values.every(Number.isFinite) || low > Math.min(open, close) || high < Math.max(open, close) || low > high) continue;

    // Exclude the still-forming bar. A price snapshot is not a confirmed candle close.
    if (time.getTime() + config.seconds * 1000 > nowMs) continue;
    candles.set(time.toISOString(), {
      time: time.toISOString(), open, high, low, close,
      // Spot gold has no consolidated exchange volume; do not plot proxy volume as fact.
      volume: 0, source: 'xaus-yahoo-proxy',
    });
  }
  return [...candles.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

async function fetchXausCandles(timeframe, limit = 600, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const config = TIMEFRAME_CONFIG[timeframe];
  if (!config) throw new Error('Unsupported XAU/USD timeframe');
  const cached = cache.get(timeframe);
  if (cached && cached.expiresAt > nowMs) return cached.candles.slice(-limit);

  const url = new URL('https://xaus.com/api/v1/chart');
  url.search = new URLSearchParams({ symbol: 'xau', range: config.range, interval: config.interval }).toString();
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw Object.assign(new Error(`XAU/USD data provider returned HTTP ${response.status}`), { status: 503 });
  const payload = await response.json();
  const candles = normalizeXausPayload(payload, timeframe, nowMs);
  if (!candles.length) throw Object.assign(new Error('XAU/USD provider returned no completed candles'), { status: 503 });
  cache.set(timeframe, { expiresAt: nowMs + CACHE_TTL_MS, candles });
  return candles.slice(-limit);
}

function clearXausCache() { cache.clear(); }

module.exports = { TIMEFRAME_CONFIG, normalizeXausPayload, fetchXausCandles, clearXausCache };
