const { NewsEvent, NewsProviderState, UserSettings } = require('./models');
const { createAlert } = require('./notifications');

const PROVIDER = 'trading_economics';

function providerDate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const iso = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function syncEconomicCalendar(now = new Date()) {
  const apiKey = process.env.TRADING_ECONOMICS_API_KEY;
  if (!apiKey) return { configured: false, imported: 0 };
  await NewsProviderState.updateOne({ provider: PROVIDER }, { $set: { provider: PROVIDER, lastAttemptAt: now } }, { upsert: true });
  try {
    const from = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    const url = new URL(`https://api.tradingeconomics.com/calendar/country/united%20states/${from}/${to}`);
    url.search = new URLSearchParams({ c: apiKey, importance: '3', values: 'true', f: 'json' }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Object.assign(new Error('Calendar provider request failed'), { status: response.status });
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Calendar provider returned an invalid response');
    const operations = [];
    for (const event of payload) {
      if (!event?.CalendarId || Number(event.Importance) !== 3) continue;
      const scheduledAt = providerDate(event.Date);
      if (!scheduledAt) continue;
      const eventId = String(event.CalendarId).slice(0, 80);
      let sourceURL;
      if (typeof event.URL === 'string') {
        try {
          const candidate = new URL(event.URL, 'https://tradingeconomics.com');
          if (candidate.protocol === 'https:' && ['tradingeconomics.com', 'www.tradingeconomics.com'].includes(candidate.hostname)) sourceURL = candidate.toString();
        } catch { /* Ignore malformed provider links. */ }
      }
      const dateSpan = Number(event.DateSpan);
      const reported = (value) => value == null || value === '' ? undefined : String(value).slice(0, 100);
      const record = {
        provider: PROVIDER, eventId, name: String(event.Event || event.Category || 'Economic event').slice(0, 180),
        country: String(event.Country || 'United States').slice(0, 80), currency: 'USD', impact: 'high', importance: 3,
        scheduledAt, dateSpan: Number.isFinite(dateSpan) ? dateSpan : null, actual: reported(event.Actual),
        forecast: reported(event.Forecast), previous: reported(event.Previous),
        source: event.Source ? String(event.Source).slice(0, 180) : undefined, sourceURL,
        lastProviderUpdateAt: providerDate(event.LastUpdate) || now,
      };
      operations.push({ updateOne: { filter: { provider: PROVIDER, eventId }, update: { $set: record }, upsert: true } });
    }
    if (operations.length) await NewsEvent.bulkWrite(operations, { ordered: false });
    await NewsProviderState.updateOne({ provider: PROVIDER }, { $set: { lastAttemptAt: now, lastSuccessfulAt: now, lastError: '', importedCount: operations.length } });
    return { configured: true, imported: operations.length };
  } catch (error) {
    const reason = error.status ? `HTTP ${error.status}` : `Provider request failed (${error.name || 'Error'})`;
    await NewsProviderState.updateOne({ provider: PROVIDER }, { $set: { lastError: reason } }).catch(() => {});
    throw Object.assign(new Error(reason), { status: error.status });
  }
}

function activeNewsWindow(events, settings, now = new Date()) {
  if (!settings?.newsFilterEnabled) return null;
  const beforeMs = Math.max(0, Number(settings.newsMinutesBefore ?? 30)) * 60_000;
  const afterMs = Math.max(0, Number(settings.newsMinutesAfter ?? 15)) * 60_000;
  return events.find((event) => event.impact === 'high' && event.dateSpan === 0 && event.currency === 'USD' && now.getTime() >= new Date(event.scheduledAt).getTime() - beforeMs && now.getTime() <= new Date(event.scheduledAt).getTime() + afterMs) || null;
}

async function alertUpcomingEvents(now = new Date()) {
  const settingsRows = await UserSettings.find({ $or: [{ newsFilterEnabled: true }, { notificationCategories: 'news' }] }).select('userId notificationCategories newsMinutesBefore newsFilterEnabled').lean();
  if (!settingsRows.length) return 0;
  const maxBefore = Math.max(1, ...settingsRows.map((settings) => Number(settings.newsMinutesBefore ?? 30)));
  const events = await NewsEvent.find({ provider: PROVIDER, impact: 'high', currency: 'USD', dateSpan: 0, scheduledAt: { $gte: now, $lte: new Date(now.getTime() + maxBefore * 60_000) } }).lean();
  let created = 0;
  for (const settings of settingsRows) {
    if (!(settings.newsFilterEnabled || settings.notificationCategories?.includes('news'))) continue;
    const beforeMs = Number(settings.newsMinutesBefore ?? 30) * 60_000;
    for (const event of events) {
      if (event.scheduledAt.getTime() - now.getTime() > beforeMs) continue;
      const alert = await createAlert({
        userId: settings.userId, eventKey: `news:${event.provider}:${event.eventId}:${event.scheduledAt.toISOString()}`,
        category: 'news', title: `High impact USD event approaching · ${event.name}`, instrument: 'XAUUSD', timeframe: 'news',
        reason: `Scheduled UTC time: ${event.scheduledAt.toISOString()}. Consensus: ${event.forecast || 'not provided'} · Previous: ${event.previous || 'not provided'}.`,
        suggestedAction: 'Review your configured news window. This alert does not predict the XAUUSD reaction; any trade decision remains manual.', href: '/news',
      });
      if (alert) created += 1;
    }
  }
  return created;
}

module.exports = { PROVIDER, providerDate, syncEconomicCalendar, activeNewsWindow, alertUpcomingEvents };
