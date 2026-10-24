const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const http = require('node:http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { WebSocketServer, WebSocket } = require('ws');
const { makeApp, JWT_SECRET, DATA_MODE } = require('./app');
const { CollectorState } = require('./models');
const { setBroadcaster, deliverPending, createAlert } = require('./notifications');
const { syncEconomicCalendar, alertUpcomingEvents } = require('./news');

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || JWT_SECRET.length < 32)) throw new Error('Set JWT_SECRET to a unique random value of at least 32 characters in production');
if (process.env.NODE_ENV === 'production' && DATA_MODE === 'provider' && (process.env.COLLECTOR_TOKEN || '').length < 32) throw new Error('COLLECTOR_TOKEN must be at least 32 characters in provider mode');

const app = makeApp();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
const clients = new Set();

function send(client, data) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
}
function broadcastUser(userId, data) {
  for (const client of clients) if (client.userId === userId) send(client, data);
}
function broadcastMarket(data) {
  for (const client of clients) send(client, data);
}
global.marketBroadcast = broadcastMarket;
setBroadcaster(broadcastUser);

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173';
  if (request.headers.origin !== allowedOrigin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const cookieHeader = request.headers.cookie || '';
  const cookies = Object.fromEntries(cookieHeader.split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const i = part.indexOf('='); return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))]; }));
  let userId;
  try { userId = jwt.verify(cookies.ati_session, JWT_SECRET, { audience: 'ati-web', issuer: 'ati-api' }).sub; } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => { ws.userId = userId; wss.emit('connection', ws, request); });
});

wss.on('connection', (client) => {
  clients.add(client);
  client.on('close', () => clients.delete(client));
  client.on('error', () => clients.delete(client));
  send(client, { type: 'connected', timestamp: new Date().toISOString() });
});

async function refreshCollectorHealth() {
  if (mongoose.connection.readyState !== 1 || DATA_MODE !== 'provider') return;
  const state = await CollectorState.findOne({ provider: 'fundingpips-mt5' });
  if (!state) return;
  const now = new Date();
  const maxAge = Math.max(5, Number(process.env.MAX_TICK_AGE_SECONDS) || 30);
  const heartbeatFresh = state.lastSeenAt && now - state.lastSeenAt <= maxAge * 2_000;
  const tickFresh = state.lastTickAt && now - state.lastTickAt <= maxAge * 1_000;
  const status = state.terminalConnected && heartbeatFresh && tickFresh ? 'connected' : heartbeatFresh ? 'delayed' : 'disconnected';
  if (state.status === status) return;
  const previous = state.status;
  state.status = status;
  await state.save();
  broadcastMarket({ type: 'connection', status, timestamp: now.toISOString() });
  const users = await mongoose.model('User').find({}, '_id').lean();
  for (const user of users) {
    await createAlert({
      userId: user._id, eventKey: `collector:${previous}:${status}:${now.toISOString()}`, category: 'data',
      title: status === 'connected' ? 'MT5 feed reconnected' : 'MT5 feed connection changed', instrument: state.symbol || 'XAUUSD',
      reason: status === 'connected' ? 'Fresh ticks and collector heartbeats are arriving again.' : `Collector state changed from ${previous} to ${status}. Old prices are hidden.`,
      suggestedAction: status === 'connected' ? 'Review the connection status before using new analysis.' : 'Check the MT5 VPS and data connection. Do not use stale prices.',
    });
  }
}

const healthTimer = setInterval(() => refreshCollectorHealth().catch(() => {}), 5_000);
const deliveryTimer = setInterval(() => deliverPending().catch(() => {}), 10_000);
const calendarTimer = setInterval(() => {
  if (mongoose.connection.readyState === 1 && process.env.TRADING_ECONOMICS_API_KEY) syncEconomicCalendar().catch((error) => console.error('economic_calendar_sync_failed', { name: error.name || 'Error', message: String(error.message || '').replace(/c=[^&\s]+/g, 'c=[redacted]').slice(0, 180) }));
}, 5 * 60_000);
const newsAlertTimer = setInterval(() => {
  if (mongoose.connection.readyState === 1) alertUpcomingEvents().catch((error) => console.error('economic_calendar_alert_failed', { name: error.name || 'Error' }));
}, 60_000);
healthTimer.unref(); deliveryTimer.unref(); calendarTimer.unref(); newsAlertTimer.unref();

const port = Math.max(1, Number(process.env.PORT) || 4000);
server.listen(port, () => console.log(`API listening on port ${port}; data mode=${DATA_MODE}`));

async function shutdown() {
  clearInterval(healthTimer); clearInterval(deliveryTimer);
  server.close();
  wss.close();
  await mongoose.disconnect();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown().finally(() => process.exit(0)));

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ai_trading_intelligence', { serverSelectionTimeoutMS: 10_000 })
  .then(() => { console.log('MongoDB connected'); if (process.env.TRADING_ECONOMICS_API_KEY) syncEconomicCalendar().catch((error) => console.error('economic_calendar_sync_failed', { name: error.name || 'Error', status: error.status })); })
  .catch((error) => console.error('MongoDB unavailable; API will remain up without persistence', { name: error.name }));
