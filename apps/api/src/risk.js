function dateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sessionKey(date) {
  const getParts = (timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]));
  const asia = getParts('Asia/Singapore');
  if (Number(asia.hour) < 8) return `asia:${asia.year}-${asia.month}-${asia.day}`;
  const london = getParts('Europe/London');
  const newYork = getParts('America/New_York');
  const inLondon = Number(london.hour) >= 8 && Number(london.hour) < 17;
  const inNewYork = Number(newYork.hour) >= 8 && Number(newYork.hour) < 17;
  if (inLondon && inNewYork) return `london_new_york_overlap:${london.year}-${london.month}-${london.day}`;
  if (inLondon) return `london:${london.year}-${london.month}-${london.day}`;
  if (inNewYork) return `new_york:${newYork.year}-${newYork.month}-${newYork.day}`;
  return `off_session:${date.toISOString().slice(0, 10)}`;
}

function dailyLossLimitBreached(trades, settings, now = new Date()) {
  if (!settings?.accountEquity || settings.accountEquity <= 0) return { breached: false, available: false, realizedLoss: 0, maxDrawdownAmount: 0 };
  const key = dateKey(now, settings.timezone || 'Asia/Dhaka');
  const closedToday = trades.filter((trade) => trade.status === 'closed' && trade.closedAt && dateKey(new Date(trade.closedAt), settings.timezone || 'Asia/Dhaka') === key).sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let equityChange = 0, peak = 0, maxDrawdownAmount = 0;
  for (const trade of closedToday) { equityChange += Number(trade.resultMoney) || 0; peak = Math.max(peak, equityChange); maxDrawdownAmount = Math.max(maxDrawdownAmount, peak - equityChange); }
  const realizedLoss = Math.min(0, equityChange);
  const maxLoss = settings.accountEquity * (settings.maxDailyLossPercent || 0) / 100;
  const maxDrawdown = settings.accountEquity * (settings.maxDailyDrawdownPercent || 0) / 100;
  const breached = (maxLoss > 0 && Math.abs(realizedLoss) >= maxLoss) || (maxDrawdown > 0 && maxDrawdownAmount >= maxDrawdown);
  return { breached, available: true, realizedLoss, maxDrawdownAmount, maxLoss, maxDrawdown };
}

function computeRisk(entry, stop, size, symbolInfo, settings) {
  const tickSize = Number(symbolInfo?.tradeTickSize);
  const tickValue = Number(symbolInfo?.tradeTickValue);
  const accountCurrency = symbolInfo?.accountCurrency;
  if (!(tickSize > 0 && tickValue > 0 && settings.accountEquity > 0 && settings.accountCurrency && settings.accountCurrency === accountCurrency)) return null;
  const amount = Math.abs(entry - stop) / tickSize * tickValue * size;
  return { amount, percentOfEquity: amount / settings.accountEquity * 100, currency: accountCurrency };
}

module.exports = { dateKey, sessionKey, dailyLossLimitBreached, computeRisk };
