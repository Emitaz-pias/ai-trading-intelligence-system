const { AlertEvent, NotificationDelivery, UserSettings } = require('./models');

let broadcast = () => {};
function setBroadcaster(fn) { broadcast = fn; }

async function sendTelegram(chatId, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error('Telegram is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(`Telegram returned HTTP ${response.status}`);
  return true;
}

async function createAlert({ userId, eventKey, category = 'trade', title, instrument = 'XAUUSD', timeframe, price, reason, suggestedAction, tradeId, href }) {
  const settings = await UserSettings.findOne({ userId }).select('+telegramChatId');
  const cooldownMinutes = Number(settings?.alertCooldownMinutes ?? 5);
  if (cooldownMinutes > 0 && eventKey.includes(':cooldown:')) {
    const baseKey = eventKey.split(':cooldown:')[0];
    const since = new Date(Date.now() - cooldownMinutes * 60_000);
    const recent = await AlertEvent.findOne({ userId, eventKey: { $regex: `^${baseKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:cooldown:` }, triggeredAt: { $gte: since } }).select('_id').lean();
    if (recent) return null;
  }
  let alert;
  try {
    alert = await AlertEvent.create({ userId, eventKey, category, title, instrument, timeframe, price, reason, suggestedAction, tradeId, href, triggeredAt: new Date() });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
  await NotificationDelivery.create({ userId, alertId: alert._id, channel: 'website', status: 'available' });
  broadcast(userId.toString(), { type: 'alert', alert: alert.toObject() });

  if (settings?.telegramEnabled && settings.telegramChatId && (settings.notificationCategories || []).includes(category)) {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      await NotificationDelivery.create({ userId, alertId: alert._id, channel: 'telegram', status: 'pending', attempts: 0, nextAttemptAt: new Date() });
    } else {
      await NotificationDelivery.create({ userId, alertId: alert._id, channel: 'telegram', status: 'failed', attempts: 0, lastError: 'Server Telegram token is not configured' });
    }
  }
  return alert;
}

function withinQuietHours(settings) {
  const { start, end } = settings?.quietHours || {};
  if (!start || !end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone || 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const current = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  const toMinutes = (value) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const from = toMinutes(start), to = toMinutes(end);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}

async function deliverPending() {
  const due = await NotificationDelivery.find({ channel: 'telegram', status: { $in: ['pending', 'retrying'] }, nextAttemptAt: { $lte: new Date() }, attempts: { $lt: 3 } }).sort({ createdAt: 1 }).limit(20);
  for (const delivery of due) {
    const settings = await UserSettings.findOne({ userId: delivery.userId }).select('+telegramChatId');
    const alert = await AlertEvent.findById(delivery.alertId);
    if (!settings?.telegramEnabled || !settings.telegramChatId || !alert) {
      delivery.status = 'failed'; delivery.lastError = 'Telegram recipient or alert is unavailable';
      await delivery.save(); continue;
    }
    if (withinQuietHours(settings)) {
      delivery.nextAttemptAt = new Date(Date.now() + 5 * 60_000);
      await delivery.save(); continue;
    }
    delivery.attempts += 1;
    try {
      await sendTelegram(settings.telegramChatId, `${alert.title}\n${alert.instrument}${alert.timeframe ? ` · ${alert.timeframe}` : ''}${Number.isFinite(alert.price) ? ` · ${alert.price}` : ''}\n${alert.reason}${alert.suggestedAction ? `\n${alert.suggestedAction}` : ''}\n${alert.triggeredAt.toISOString()}`);
      delivery.status = 'delivered'; delivery.deliveredAt = new Date(); delivery.lastError = undefined;
    } catch (error) {
      delivery.lastError = String(error.message || 'Telegram delivery failed').slice(0, 300);
      delivery.status = delivery.attempts >= 3 ? 'failed' : 'retrying';
      delivery.nextAttemptAt = new Date(Date.now() + delivery.attempts * 60_000);
    }
    await delivery.save();
  }
}

module.exports = { setBroadcaster, createAlert, deliverPending, sendTelegram };
