import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert, AppBar, Avatar, Box, Button, Card, CardContent, Checkbox, Chip, CircularProgress, Container, Dialog,
  DialogActions, DialogContent, DialogTitle, Divider, Drawer, FormControl, FormControlLabel, IconButton, InputLabel,
  Menu, MenuItem, Paper, Select, Snackbar, Stack, TextField, Toolbar, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ArrowDownwardRounded, ArrowUpwardRounded, EventNoteRounded, HistoryRounded, LogoutRounded, MenuBookRounded, MonitorHeartRounded, NotificationsActiveRounded, QueryStatsRounded, RefreshRounded, ScienceRounded, SettingsRounded, ShieldRounded, ShowChartRounded, SpaceDashboardRounded, TrackChangesRounded, WarningAmberRounded } from './icons';
import { api, json, patchJson, webSocketUrl } from './api';
import MarketChart from './components/MarketChart';
import type { Alert as AlertEvent, AnalysisResponse, Candle, MarketStatus, NewsEvent, RiskStatus, Settings, Trade } from './types';

type User = { id: string; email: string };
type AuthResponse = { user: User };
const drawerWidth = 244;

const navigation = [
  { label: 'Dashboard', path: '/', icon: <SpaceDashboardRounded /> },
  { label: 'Live Chart', path: '/chart', icon: <ShowChartRounded /> },
  { label: 'Market Analysis', path: '/analysis', icon: <QueryStatsRounded /> },
  { label: 'Trading Setups', path: '/setups', icon: <TrackChangesRounded /> },
  { label: 'Open Trade Monitor', path: '/trades', icon: <MonitorHeartRounded /> },
  { label: 'Historical Analysis', path: '/history', icon: <HistoryRounded /> },
  { label: 'News & Events', path: '/news', icon: <EventNoteRounded /> },
  { label: 'Backtesting', path: '/backtesting', icon: <ScienceRounded /> },
  { label: 'Trade Journal', path: '/journal', icon: <MenuBookRounded /> },
  { label: 'Risk Management', path: '/risk', icon: <ShieldRounded /> },
  { label: 'Settings', path: '/settings', icon: <SettingsRounded /> },
];

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function price(value?: number | null) { return Number.isFinite(value) ? (value as number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function marketSessionNow() {
  const hour = (zone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const asia = hour('Asia/Singapore') < 8;
  const london = hour('Europe/London') >= 8 && hour('Europe/London') < 17;
  const newYork = hour('America/New_York') >= 8 && hour('America/New_York') < 17;
  return london && newYork ? 'London–New York overlap' : london ? 'London' : newYork ? 'New York' : asia ? 'Asia' : 'Off-session';
}
function titleFor(path: string) { return navigation.find((item) => item.path === path)?.label || 'Dashboard'; }

export default function App() {
  return <BrowserRouter><AppGate /></BrowserRouter>;
}

function AppGate() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<AuthResponse>('/auth/me').then((value) => setUser(value.user)).catch(() => {}).finally(() => setLoading(false)); }, []);
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setAuthError('');
    try {
      const value = await api<AuthResponse>('/auth/login', json({ email, password }));
      setUser(value.user);
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Could not sign in'); }
    finally { setBusy(false); }
  };
  if (loading) return <Box minHeight="100vh" display="grid" sx={{ placeItems: 'center' }}><CircularProgress size={24} /></Box>;
  if (!user && !showSignIn) return <GuestChartPage onSignIn={() => setShowSignIn(true)} />;
  if (!user) return <Box minHeight="100vh" className="grid-glow" display="grid" sx={{ placeItems: 'center', px: 2 }}>
    <Card sx={{ width: '100%', maxWidth: 430 }}><CardContent sx={{ p: { xs: 3, sm: 4 } }}>
      <Stack spacing={3}>
        <Stack direction="row" alignItems="center" spacing={1.5}><Avatar sx={{ bgcolor: 'primary.main', color: '#071411', width: 42, height: 42 }}>AI</Avatar><Box><Typography fontWeight={700}>Trading Intelligence</Typography><Typography variant="caption" color="text.secondary">XAUUSD · alert-only workspace</Typography></Box></Stack>
        <Box><Typography variant="h5" fontWeight={700}>Welcome back</Typography><Typography color="text.secondary" variant="body2" mt={0.6}>Sign in to your existing account. Live XAUUSD chart access does not require an account.</Typography></Box>
        {authError && <Alert severity="error">{authError}</Alert>}
        <Box component="form" onSubmit={authenticate}>
          <Stack spacing={2}><TextField label="Email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required fullWidth />
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} inputProps={{ maxLength: 128 }} required fullWidth />
            <Button type="submit" variant="contained" size="large" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</Button>
          </Stack>
        </Box>
        <Button variant="text" onClick={() => { setShowSignIn(false); setAuthError(''); }}>Back to live chart</Button>
      </Stack>
    </CardContent></Card>
  </Box>;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function GuestChartPage({ onSignIn }: { onSignIn: () => void }) { return <LiveChartPage onSignIn={onSignIn} />; }

type PublicChartResponse = AnalysisResponse & { symbol: string; timeframe: string; candles: Candle[]; sourceLabel: string };

function LiveChartPage({ onSignIn }: { onSignIn?: () => void }) {
  const [timeframe, setTimeframe] = useState('M15');
  const [data, setData] = useState<PublicChartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setData(await api<PublicChartResponse>(`/public/market/chart?timeframe=${encodeURIComponent(timeframe)}`)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Market analysis is unavailable'); }
    finally { setLoading(false); }
  }, [timeframe]);
  useEffect(() => { setLoading(true); setData(null); load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer); }, [load]);

  const result = data?.results?.[timeframe];
  const context = data?.results?.M15;
  const plan = data?.tradePlan;
  const status = data?.marketStatus;
  return <Box minHeight="100vh" className="grid-glow" sx={{ py: { xs: 2, md: 3 } }}>
    <Container maxWidth={false} sx={{ maxWidth: 1600, px: { xs: 2, sm: 2.5, lg: 3.5 } }}>
      {onSignIn && <Stack direction="row" justifyContent="space-between" alignItems="center" mb={3}>
        <Stack direction="row" alignItems="center" spacing={1.5}><Avatar sx={{ bgcolor: 'primary.main', color: '#071411', width: 40, height: 40 }}>AI</Avatar><Box><Typography fontWeight={700}>Trading Intelligence</Typography><Typography variant="caption" color="text.secondary">XAUUSD · market analysis</Typography></Box></Stack>
        <Button variant="outlined" onClick={onSignIn}>Sign in</Button>
      </Stack>}
      <PageTitle title="XAUUSD chart & analysis" subtitle="Recent reference candles with rule-based structure, liquidity and zones drawn on the same chart." action={<Stack direction="row" spacing={1}><FormControl size="small" sx={{ minWidth: 105 }}><InputLabel>Timeframe</InputLabel><Select label="Timeframe" value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>{['M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((tf) => <MenuItem key={tf} value={tf}>{tf}</MenuItem>)}</Select></FormControl><Button variant="outlined" startIcon={<RefreshRounded />} onClick={load}>Refresh</Button></Stack>} />
      {status && <Alert severity={status.isFresh ? 'warning' : 'error'} sx={{ mb: 1.5 }}><b>{status.connectionLabel}.</b> {status.warnings.join(' ')}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
      {loading && !data ? <Stack alignItems="center" py={8}><CircularProgress size={25} /><Typography color="text.secondary" variant="caption" mt={1}>Loading XAU/USD reference candles and analysis…</Typography></Stack> : data && <>
        <Card><CardContent sx={{ p: { xs: 1, md: 1.5 } }}><MarketChart candles={data.candles} analysis={result} trades={[]} timeframe={timeframe} symbol={data.symbol} sourceMode={data.sourceMode} /><Typography variant="caption" color="text.secondary" display="block" mt={0.5}>Last completed {timeframe} bar: {formatTime(data.candles.at(-1)?.time)} · values and overlays use closed bars.</Typography></CardContent></Card>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1.4, mt: 1.4 }}>
          <Card><CardContent>
            <Typography fontWeight={700}>Current structure · M15</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap gap={0.6} mt={1}>
              {['D1', 'H4', 'H1', 'M30', 'M15', 'M5'].map((tf) => <Chip key={tf} size="small" variant="outlined" label={`${tf} · ${data.results[tf]?.regime?.replaceAll('_', ' ') || data.results[tf]?.status || 'insufficient'}`} />)}
            </Stack>
            <Typography color="text.secondary" variant="body2" mt={0.8}>Regime: <b>{context?.regime?.replaceAll('_', ' ') || context?.status || 'insufficient data'}</b> · {context?.candlesAnalyzed || 0} completed candles</Typography>
            <Typography color="text.secondary" variant="body2" mt={0.7}>Latest confirmed event: <b>{context?.structure?.filter((event) => event.confirmed).at(-1)?.type || 'none'}</b> {context?.structure?.filter((event) => event.confirmed).at(-1)?.direction || ''}</Typography>
            <Stack direction="row" spacing={1} mt={1.2}>
              <Chip size="small" variant="outlined" label={`Support ${context?.nearestSupport ? `${price(context.nearestSupport.low)}–${price(context.nearestSupport.high)}` : '—'}`} />
              <Chip size="small" variant="outlined" label={`Resistance ${context?.nearestResistance ? `${price(context.nearestResistance.low)}–${price(context.nearestResistance.high)}` : '—'}`} />
            </Stack>
            <Typography color="text.secondary" variant="caption" display="block" mt={1}>Swing points, BOS/CHoCH, liquidity references and supply/demand zones are rule-calculated and shown on the selected timeframe chart.</Typography>
            {data.report.explanations.slice(0, 2).map((item) => <Typography key={item} color="text.secondary" variant="caption" display="block" mt={0.8}>{item}</Typography>)}
          </CardContent></Card>
          <Card><CardContent>
            <Stack direction="row" alignItems="center" spacing={1}><Typography fontWeight={700}>Trade decision</Typography><Chip size="small" color="warning" label={plan?.state?.replaceAll('_', ' ') || 'WAITING'} /></Stack>
            <Typography color="text.secondary" variant="body2" mt={1}>{plan?.explanation || 'Waiting for enough completed candles.'}</Typography>
            {plan?.reasonsToAvoid?.map((reason) => <Typography key={reason} color="text.secondary" variant="caption" display="block" mt={0.7}>• {reason}</Typography>)}
          </CardContent></Card>
        </Box>
        <Typography color="text.secondary" variant="caption" display="block" mt={1.2}>Source: {data.sourceLabel}. The reference feed can differ from OANDA/FundingPips; spot gold has no consolidated exchange volume. Updated from the cloud API about once per minute. No orders are placed.</Typography>
      </>}
    </Container>
  </Box>;
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('md'));
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [snackOpen, setSnackOpen] = useState(false);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const loadStatus = useCallback(() => { api<MarketStatus>('/market/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { loadStatus(); const timer = window.setInterval(loadStatus, 15_000); return () => window.clearInterval(timer); }, [loadStatus, refreshKey]);
  useEffect(() => {
    const ws = new WebSocket(webSocketUrl());
    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data);
        if (data.type === 'alert') { setNotice(data.alert?.title || 'New alert'); setSnackOpen(true); }
        refresh();
      } catch { /* Ignore malformed server messages. */ }
    };
    return () => ws.close();
  }, [refresh]);

  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setAnchor(null); onLogout(); };
  const navigationContent = <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <Stack direction="row" spacing={1.2} alignItems="center" px={2.4} py={2.7}>
      <Box sx={{ width: 35, height: 35, display: 'grid', placeItems: 'center', borderRadius: 1.5, bgcolor: 'primary.main', color: '#081511', fontWeight: 900, fontSize: 13 }}>AI</Box>
      <Box><Typography fontWeight={700} fontSize={13.5}>MARKET INTELLIGENCE</Typography><Typography variant="caption" color="text.secondary">GOLD · XAUUSD</Typography></Box>
    </Stack>
    <Divider />
    <Typography className="panel-kicker" px={2.5} pt={2.6} pb={1.2}>Workspace</Typography>
    <Stack component="nav" spacing={0.3} px={1.3} sx={{ overflowY: 'auto' }}>
      {navigation.map((item) => <NavLink key={item.path} to={item.path} onClick={() => setMobileOpen(false)} style={{ color: 'inherit', textDecoration: 'none' }}>
        {({ isActive }) => <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.4, px: 1.35, py: 1.15, mb: 0.25, borderRadius: 1.5, color: isActive ? 'primary.main' : 'text.secondary', bgcolor: isActive ? 'rgba(73,212,179,0.09)' : 'transparent', border: isActive ? '1px solid rgba(73,212,179,0.12)' : '1px solid transparent', '&:hover': { bgcolor: 'rgba(143,162,178,0.07)', color: 'text.primary' } }}>
          <Box sx={{ display: 'flex', '& svg': { fontSize: 19 } }}>{item.icon}</Box><Typography fontSize={12.5} fontWeight={isActive ? 650 : 500}>{item.label}</Typography>
        </Box>}
      </NavLink>)}
    </Stack>
    <Box sx={{ mt: 'auto', p: 1.6 }}><Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'rgba(73,212,179,.035)' }}>
      <Stack direction="row" alignItems="center" spacing={0.8}><Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: status?.isFresh ? 'success.main' : 'warning.main', boxShadow: status?.isFresh ? '0 0 10px rgba(73,212,179,.8)' : 'none' }} /><Typography fontSize={11} fontWeight={600}>{status?.connectionLabel || 'Checking feed…'}</Typography></Stack>
      <Typography variant="caption" color="text.secondary" display="block" mt={1}>Alert-only · no order execution</Typography>
    </Paper></Box>
  </Box>;

  return <Box sx={{ minHeight: '100vh', display: 'flex' }}>
    {mobile ? <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ '& .MuiDrawer-paper': { width: drawerWidth, bgcolor: '#101820', borderRight: '1px solid rgba(143,162,178,.14)' } }}>{navigationContent}</Drawer>
      : <Drawer variant="permanent" sx={{ width: drawerWidth, flexShrink: 0, '& .MuiDrawer-paper': { width: drawerWidth, bgcolor: '#101820', borderRight: '1px solid rgba(143,162,178,.14)' } }}>{navigationContent}</Drawer>}
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <AppBar position="sticky" elevation={0} color="transparent" sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(11,16,21,.88)', backdropFilter: 'blur(12px)' }}>
        <Toolbar sx={{ minHeight: '68px !important', px: { xs: 2, md: 3.5 } }}>
          {mobile && <IconButton onClick={() => setMobileOpen(true)} sx={{ mr: 1 }}><IconMark icon={<SpaceDashboardRounded />} /></IconButton>}
          <Box sx={{ flex: 1 }}><Typography variant="subtitle1" fontWeight={700}>{titleFor(location.pathname)}</Typography><Typography variant="caption" color="text.secondary">{location.pathname === '/' ? 'Market overview and monitored activity' : 'XAUUSD · analysis workspace'}</Typography></Box>
          <Tooltip title={status?.connectionLabel || 'Connection status'}><Chip size="small" icon={<Box component="span" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: status?.isFresh ? 'success.main' : 'warning.main', ml: 1.2 }} />} label={status?.connectionStatus === 'connected' ? 'LIVE FEED' : status?.connectionStatus === 'illustrative' ? 'ILLUSTRATIVE' : 'FEED OFFLINE'} variant="outlined" sx={{ mr: { xs: 1, sm: 2 }, borderColor: status?.isFresh ? 'rgba(73,212,179,.3)' : 'rgba(245,189,99,.3)', color: status?.isFresh ? 'success.main' : 'warning.main', fontSize: 9, fontWeight: 800, letterSpacing: '.06em', '& .MuiChip-icon': { width: 10, height: 10 } }} /></Tooltip>
          <Tooltip title="Refresh"><IconButton size="small" onClick={() => { loadStatus(); refresh(); }} sx={{ mr: 1 }}><RefreshRounded fontSize="small" /></IconButton></Tooltip>
          <IconButton onClick={(event) => setAnchor(event.currentTarget)}><Avatar sx={{ width: 31, height: 31, bgcolor: '#263742', color: 'primary.main', fontSize: 12 }}>{user.email.slice(0, 1).toUpperCase()}</Avatar></IconButton>
          <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}><MenuItem disabled>{user.email}</MenuItem><Divider /><MenuItem onClick={logout}><LogoutRounded fontSize="small" sx={{ mr: 1 }} /> Sign out</MenuItem></Menu>
        </Toolbar>
      </AppBar>
      <Container maxWidth={false} sx={{ maxWidth: 1600, px: { xs: 2, sm: 2.5, lg: 3.5 }, py: { xs: 2.5, md: 3.5 } }}>
        <Routes>
          <Route path="/" element={<Dashboard status={status} refreshKey={refreshKey} />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route path="/analysis" element={<AnalysisPage refreshKey={refreshKey} />} />
          <Route path="/setups" element={<SetupsPage refreshKey={refreshKey} />} />
          <Route path="/trades" element={<TradeMonitor refreshKey={refreshKey} status={status} />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/backtesting" element={<BacktestingPage />} />
          <Route path="/journal" element={<JournalPage refreshKey={refreshKey} />} />
          <Route path="/risk" element={<RiskPage refreshKey={refreshKey} status={status} />} />
          <Route path="/settings" element={<SettingsPage refreshKey={refreshKey} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
    </Box>
    <Snackbar open={snackOpen} autoHideDuration={5000} onClose={() => setSnackOpen(false)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}><Alert severity="info" onClose={() => setSnackOpen(false)} icon={<NotificationsActiveRounded />}>{notice}</Alert></Snackbar>
  </Box>;
}

function IconMark({ icon }: { icon: ReactNode }) { return <Box sx={{ display: 'flex', '& svg': { fontSize: 20 } }}>{icon}</Box>; }

function PageTitle({ eyebrow = 'XAUUSD · MARKET INTELLIGENCE', title, subtitle, action }: { eyebrow?: string; title: string; subtitle: string; action?: ReactNode }) {
  return <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'flex-end' }} spacing={2} mb={3}>
    <Box><Typography className="panel-kicker" mb={0.9}>{eyebrow}</Typography><Typography variant="h4" fontWeight={700} sx={{ fontSize: { xs: 26, md: 32 } }}>{title}</Typography><Typography color="text.secondary" mt={0.8} fontSize={13}>{subtitle}</Typography></Box>{action}
  </Stack>;
}

function StatusBanner({ status }: { status: MarketStatus | null }) {
  if (!status) return <Alert severity="info" sx={{ mb: 2.5 }}>Checking market-data status…</Alert>;
  if (status.mode === 'illustrative') return <Alert severity="warning" icon={<WarningAmberRounded />} sx={{ mb: 2.5, alignItems: 'center' }}><Typography component="span" fontWeight={700}>Illustrative development mode.</Typography> Synthetic candles are shown for interface and rule-engine checks; they are not market data. Live prices and actionable plans are disabled.</Alert>;
  if (status.mode === 'xaus') return <Alert severity="warning" icon={<WarningAmberRounded />} sx={{ mb: 2.5, alignItems: 'center' }}><Typography component="span" fontWeight={700}>{status.connectionLabel}.</Typography> {status.warnings.join(' ')}</Alert>;
  if (!status.isFresh) return <Alert severity="error" icon={<WarningAmberRounded />} sx={{ mb: 2.5, alignItems: 'center' }}><Typography component="span" fontWeight={700}>{status.connectionLabel}.</Typography> The current price is withheld until fresh MT5 data returns. {status.warnings?.join(' ')}</Alert>;
  return <Alert severity="success" sx={{ mb: 2.5, alignItems: 'center' }}><Typography component="span" fontWeight={700}>Read-only MT5 feed is fresh.</Typography> {status.symbol} · {status.accountServer || 'server not reported'} · no broker orders can be placed by this app.</Alert>;
}

function Dashboard({ status, refreshKey }: { status: MarketStatus | null; refreshKey: number }) {
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [risk, setRisk] = useState<RiskStatus | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [news, setNews] = useState<{ configured: boolean; events: NewsEvent[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setError('');
    const results = await Promise.allSettled([
      api<AnalysisResponse>('/market/analysis'), api<{ trades: Trade[] }>('/trades'), api<{ alerts: AlertEvent[] }>('/alerts'), api<RiskStatus>('/risk/status'), api<{ configured: boolean; events: NewsEvent[] }>('/news'),
    ]);
    if (results[0].status === 'fulfilled') setAnalysis(results[0].value); else setError(results[0].reason instanceof Error ? results[0].reason.message : 'Market analysis unavailable');
    if (results[1].status === 'fulfilled') setTrades(results[1].value.trades);
    if (results[2].status === 'fulfilled') setAlerts(results[2].value.alerts);
    if (results[3].status === 'fulfilled') setRisk(results[3].value);
    if (results[4].status === 'fulfilled') setNews(results[4].value);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  const results = analysis?.results || {};
  const summary = [
    { label: 'D1 BIAS', value: results.D1?.regime?.replace('_', ' ') || '—', note: 'Major direction', color: 'primary.main' },
    { label: 'H4 BIAS', value: results.H4?.regime?.replace('_', ' ') || '—', note: 'Major structure', color: 'info.main' },
    { label: 'H1 BIAS', value: results.H1?.regime?.replace('_', ' ') || '—', note: 'Intermediate context', color: 'warning.main' },
    { label: 'M15 BIAS', value: results.M15?.regime?.replace('_', ' ') || '—', note: 'Entry confirmation', color: 'secondary.main' },
  ];
  const levels = results.H1;
  if (loading) return <Stack alignItems="center" py={10}><CircularProgress size={26} /></Stack>;
  return <Box className="page-enter">
    <PageTitle title="Market overview" subtitle="A clear view of structure, data quality and your configured trade risk." action={<Button variant="outlined" startIcon={<RefreshRounded />} onClick={load}>Refresh analysis</Button>} />
    <StatusBanner status={status} />
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' }, gap: 1.5, mb: 1.5 }}>
      <MetricCard label="XAUUSD · current" value={status?.isFresh ? price(status.currentPrice) : '—'} unit={status?.isFresh ? status.mode === 'xaus' ? 'Indicative candle close' : 'Broker quote' : 'Not available'} foot={status?.isFresh ? `As of ${formatTime(status.latestTickAt)}` : 'No fresh quote'} accent={status?.isFresh ? 'success.main' : 'text.secondary'} />
      <MetricCard label="Market session" value={marketSessionNow()} unit="IANA timezone based" foot="Asia · London · New York windows" accent="text.primary" />
      <MetricCard label="M15 volatility" value={results.M15?.volatility?.state || '—'} unit="True range · deterministic" foot={`ATR(14) ${results.M15?.atr14 ? price(results.M15.atr14) : '—'}`} accent="info.main" />
      <MetricCard label="Active monitoring" value={String(trades.length)} unit="Manually registered trades" foot={`${alerts.length} recorded alerts`} accent="primary.main" />
    </Box>
    <Card sx={{ mb: 1.5 }}><CardContent sx={{ p: 2.2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.7}><Box><Typography fontSize={14} fontWeight={700}>Multi-timeframe bias</Typography><Typography variant="caption" color="text.secondary">Confirmed structure · values update with stored candles</Typography></Box>{analysis?.report?.conflict && <Chip size="small" color="warning" label="Timeframe conflict" />}</Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1.2 }}>{summary.map((item) => <Box key={item.label} sx={{ p: 1.6, borderRadius: 2, bgcolor: 'rgba(255,255,255,.025)', border: '1px solid', borderColor: 'divider' }}>
        <Typography className="panel-kicker">{item.label}</Typography><Typography textTransform="capitalize" fontWeight={650} mt={1} color={item.color}>{item.value}</Typography><Typography variant="caption" color="text.secondary">{item.note}</Typography>
      </Box>)}</Box>
      {analysis?.report?.explanations?.map((text, index) => <Typography key={index} variant="body2" color="text.secondary" mt={1.6}>{text}</Typography>)}
    </CardContent></Card>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.15fr .85fr' }, gap: 1.5, mb: 1.5 }}>
      <Card><CardContent sx={{ p: 2.2 }}><Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}><Box><Typography fontSize={14} fontWeight={700}>Nearest H1 levels</Typography><Typography variant="caption" color="text.secondary">Pivot clusters · each is a rule-based zone</Typography></Box><Chip size="small" variant="outlined" label="Rule: pivot cluster" /></Stack>
        <Stack direction="row" spacing={1.2}>
          <LevelCard label="SUPPORT" zone={levels?.nearestSupport} color="success.main" />
          <LevelCard label="RESISTANCE" zone={levels?.nearestResistance} color="error.main" />
        </Stack>
      </CardContent></Card>
      <Card><CardContent sx={{ p: 2.2 }}><Typography fontSize={14} fontWeight={700} mb={0.5}>Conditional action plan</Typography><Typography variant="caption" color="text.secondary">This is a state, not a buy/sell instruction.</Typography>
        <Stack direction="row" alignItems="center" spacing={1} mt={1.8} mb={1}><Chip size="small" color={analysis?.tradePlan.state === 'DATA_UNAVAILABLE' || analysis?.tradePlan.state === 'NO_TRADE' ? 'warning' : 'info'} label={analysis?.tradePlan.state?.replaceAll('_', ' ') || 'LOADING'} /><Typography variant="caption" color="text.secondary">{analysis?.tradePlan.setupType || 'No confirmed setup'}</Typography></Stack>
        <Typography variant="body2" color="text.secondary">{analysis?.tradePlan.conditions?.[0] || 'Waiting for data.'}</Typography>
        {analysis?.tradePlan.invalidation && <Typography variant="caption" display="block" mt={1.2} color="warning.main">Invalidation: {analysis.tradePlan.invalidation}</Typography>}
      </CardContent></Card>
    </Box>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1.5 }}>
      <Card><CardContent sx={{ p: 2.2 }}><Typography fontSize={14} fontWeight={700}>Risk guardrails</Typography><Typography variant="caption" color="text.secondary" display="block" mb={1.6}>App-level limits · not enforced by MT5</Typography>
        {risk ? <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Chip size="small" label={`${risk.tradesToday} / ${risk.configured.maxTradesPerDay} trades today`} /><Chip size="small" label={`${risk.activeTrades} / ${risk.configured.maxSimultaneousTrades} active`} /><Chip size="small" label={`${risk.consecutiveLosses} consecutive losses`} color={risk.limitsBreached ? 'error' : 'default'} /></Stack> : <Typography color="text.secondary" variant="body2">Risk status unavailable.</Typography>}
        {risk?.limitsBreached && <Alert severity="error" sx={{ mt: 1.5 }}>A configured daily limit has been reached. The app blocks new trade records.</Alert>}
      </CardContent></Card>
      <Card><CardContent sx={{ p: 2.2 }}><Typography fontSize={14} fontWeight={700}>Upcoming economic events</Typography><Typography variant="caption" color="text.secondary" display="block" mb={1.2}>{news?.configured ? 'High impact · USD · Trading Economics' : 'Calendar provider not configured'}</Typography>{news?.events.filter((event) => new Date(event.scheduledAt) >= new Date()).slice(0, 2).map((event) => <Box key={event.eventId} mb={1}><Typography fontSize={13} fontWeight={650}>{event.name}</Typography><Typography variant="caption" color="text.secondary">{event.dateSpan === 0 ? '' : 'Estimated · '}{formatTime(event.scheduledAt)} · {event.forecast ? `consensus ${event.forecast}` : 'no consensus reported'}</Typography></Box>)}{!news?.configured ? <Alert severity="info" icon={<EventNoteRounded />} sx={{ py: 0.1 }}>No events are shown until the server calendar key is configured.</Alert> : !news.events.some((event) => new Date(event.scheduledAt) >= new Date()) && <Typography variant="body2" color="text.secondary">No upcoming events in the provider window.</Typography>}</CardContent></Card>
    </Box>
    <Stack direction="row" justifyContent="flex-end" mt={1.7}><Typography variant="caption" color="text.secondary">Last successful market update: {formatTime(status?.lastSuccessfulUpdateAt)} · timezone Asia/Dhaka</Typography></Stack>
  </Box>;
}

function MetricCard({ label, value, unit, foot, accent }: { label: string; value: string; unit: string; foot: string; accent: string }) {
  return <Card><CardContent sx={{ p: { xs: 1.7, sm: 2.1 } }}><Typography className="panel-kicker">{label}</Typography><Typography variant="h5" fontWeight={700} mt={1.4} sx={{ color: accent, fontSize: { xs: 20, sm: 25 } }}>{value}</Typography><Typography fontSize={11} color="text.secondary" mt={0.4}>{unit}</Typography><Divider sx={{ my: 1.35 }} /><Typography variant="caption" color="text.secondary">{foot}</Typography></CardContent></Card>;
}

function LevelCard({ label, zone, color }: { label: string; zone?: { low: number; high: number; mid: number; tests: number; strength: string } | null; color: string }) {
  return <Box sx={{ flex: 1, borderRadius: 2, p: 1.6, bgcolor: 'rgba(255,255,255,.025)', border: '1px solid', borderColor: 'divider' }}><Typography className="panel-kicker" color={color}>{label}</Typography><Typography className="mono" fontWeight={700} fontSize={19} mt={1}>{zone ? `${price(zone.low)} – ${price(zone.high)}` : 'Insufficient data'}</Typography>{zone && <Typography variant="caption" color="text.secondary">{zone.strength} · {zone.tests} confirmed reactions · midpoint {price(zone.mid)}</Typography>}</Box>;
}

function useAnalysis(refreshKey: number) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api<AnalysisResponse>('/market/analysis')); } catch (e) { setError(e instanceof Error ? e.message : 'Analysis could not be loaded'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  return { data, loading, error, reload: load };
}

function ChartPage() {
  return <LiveChartPage />;
}

function AnalysisPage({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error, reload } = useAnalysis(refreshKey);
  const [explanation, setExplanation] = useState<{ englishSummary: string; banglaExplanation: string; confirmedFindings: string[]; hypotheses: string[]; conflicts: string[]; waitFor: string[]; dataLimitations: string[] } | null>(null);
  const [aiError, setAiError] = useState('');
  const explain = async () => { setAiError(''); try { const value = await api<{ explanation: NonNullable<typeof explanation> }>('/market/explain', { method: 'POST' }); setExplanation(value.explanation); } catch (e) { setAiError(e instanceof Error ? e.message : 'AI explanation unavailable'); } };
  if (loading) return <Stack alignItems="center" py={10}><CircularProgress size={26} /></Stack>;
  return <Box className="page-enter"><PageTitle title="Market analysis" subtitle="Rule-based structure with the evidence, timeframe and limitations kept visible." action={<Button variant="outlined" startIcon={<RefreshRounded />} onClick={reload}>Recalculate</Button>} />
    {error ? <Alert severity="error">{error}</Alert> : data && <><StatusBanner status={data.marketStatus} />
      {data.report.explanations.map((explanationText, index) => <Alert key={index} severity={data.report.conflict ? 'warning' : 'info'} sx={{ mb: 1 }}>{explanationText}</Alert>)}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 1.4, mt: 1.5 }}>
        {Object.entries(data.report.timeframes).map(([timeframe, context]) => { const result = data.results[timeframe]; return <Card key={timeframe}><CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start"><Box><Typography fontSize={12} fontWeight={800} color="primary.main">{timeframe}</Typography><Typography fontWeight={700} mt={0.3}>{context.role}</Typography></Box><Chip size="small" label={context.regime?.replaceAll('_', ' ') || 'INSUFFICIENT DATA'} variant="outlined" /></Stack>
          <Typography variant="caption" display="block" color="text.secondary" mt={1}>As of {formatTime(result?.asOf)} · {result?.candlesAnalyzed || 0} bars · {result?.volatility?.state || 'volatility unavailable'}</Typography>
          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" spacing={1}><LevelCard label="SUPPORT" zone={result?.nearestSupport} color="success.main" /><LevelCard label="RESISTANCE" zone={result?.nearestResistance} color="error.main" /></Stack>
          {(result?.supplyDemand || []).length > 0 && <Box mt={1.2}><Typography className="panel-kicker">SUPPLY / DEMAND CANDIDATES</Typography>{(result?.supplyDemand || []).slice(-3).map((zone) => <Typography key={`${zone.ruleId}-${zone.baseFrom}`} variant="caption" color="text.secondary" display="block" mt={0.5}>{zone.type} {price(zone.low)}–{price(zone.high)} · {zone.status} · {zone.tests} retest(s)</Typography>)}</Box>}
          {(result?.liquidity?.levels || []).filter((level) => level.type.startsWith('previous_') || level.type.startsWith('equal_')).slice(-4).map((level) => <Typography key={`${level.type}-${level.from}`} variant="caption" color={level.potentialSweepAt ? 'warning.main' : 'text.secondary'} display="block" mt={0.5}>Liquidity · {level.type.replaceAll('_', ' ')} {price(level.price)}{level.potentialSweepAt ? ` · potential sweep ${formatTime(level.potentialSweepAt)}` : ''}</Typography>)}
          <Typography variant="caption" color="text.secondary" display="block" mt={1.4}>Latest confirmed structures: {(result?.structure || []).slice(-4).map((item) => `${item.type} ${item.direction} at ${price(item.level)}`).join(' · ') || 'none'}</Typography>
          {result?.limitations?.slice(0, 2).map((item) => <Typography key={item} variant="caption" color="text.secondary" display="block" mt={0.8}>• {item}</Typography>)}
        </CardContent></Card>; })}
      </Box>
      <Card sx={{ mt: 1.5 }}><CardContent><Typography fontWeight={700} fontSize={14}>Conditional action plan</Typography><PlanDisplay plan={data.tradePlan} /></CardContent></Card>
      <Card sx={{ mt: 1.5 }}><CardContent><Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}><Box><Typography fontWeight={700} fontSize={14}>Explanation in simple Bangla</Typography><Typography variant="caption" color="text.secondary">AI explains deterministic findings; it cannot edit levels or plan state.</Typography></Box><Button variant="contained" onClick={explain}>Explain findings</Button></Stack>
        {aiError && <Alert severity="info" sx={{ mt: 1.5 }}>{aiError}</Alert>}
        {explanation && <Stack spacing={1.4} mt={2}><Typography variant="body2">{explanation.englishSummary}</Typography><Typography variant="body2" color="primary.main">{explanation.banglaExplanation}</Typography><BulletGroup title="Confirmed findings" items={explanation.confirmedFindings} /><BulletGroup title="Hypotheses" items={explanation.hypotheses} /><BulletGroup title="Wait for" items={explanation.waitFor} /><BulletGroup title="Data limitations" items={explanation.dataLimitations} /></Stack>}
      </CardContent></Card>
    </>}
  </Box>;
}

function SetupsPage({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useAnalysis(refreshKey);
  if (loading) return <Stack alignItems="center" py={10}><CircularProgress size={26} /></Stack>;
  return <Box className="page-enter"><PageTitle title="Trading setups" subtitle="Conditional states with explicit confirmation and invalidation requirements." />
    {error ? <Alert severity="error">{error}</Alert> : data && <><StatusBanner status={data.marketStatus} /><Card><CardContent><Typography fontWeight={700} fontSize={15} mb={1}>Current plan state</Typography><PlanDisplay plan={data.tradePlan} /></CardContent></Card>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}><PlanMethod title="Breakout entry" text="Requires a completed M15 candle close beyond a confirmed swing level. A wick alone is provisional. Immediate entry can participate earlier but is more exposed to false breaks." /><PlanMethod title="Retest entry" text="Waits for price to revisit the broken level and print rejection in the break direction. It may reduce false-break exposure but can miss a move that never retests. This release does not claim either method is superior." /></Box>
      <Alert severity="info" sx={{ mt: 1.5 }}>Compare these entry styles using the Backtesting page. It uses the same explicit rule assumptions for each run and only accepts stored provider candles; small test samples are shown with their sample count.</Alert>
    </>}
  </Box>;
}

function PlanDisplay({ plan }: { plan: NonNullable<AnalysisResponse['tradePlan']> }) {
  return <><Stack direction="row" alignItems="center" spacing={1} mt={1}><Chip size="small" color={plan.state === 'DATA_UNAVAILABLE' || plan.state === 'NO_TRADE' ? 'warning' : plan.state === 'SETUP_CONFIRMED' ? 'success' : 'info'} label={plan.state.replaceAll('_', ' ')} />{plan.direction && <Chip size="small" variant="outlined" label={plan.direction} />}{plan.setupType && <Chip size="small" variant="outlined" label={plan.setupType} />}</Stack>
    {plan.newsFilterActive && plan.newsEvent && <Alert severity="warning" sx={{ mt: 1.2 }}>Configured high-impact news window: {plan.newsEvent.name} · {formatTime(plan.newsEvent.scheduledAt)}. Underlying setup state: {plan.underlyingState}. Reassess after the configured event window.</Alert>}
    {plan.relevantZone && <Typography className="mono" mt={1.5} fontSize={14}>Relevant zone: {price(plan.relevantZone.low)} – {price(plan.relevantZone.high)}</Typography>}
    <BulletGroup title="Conditions" items={plan.conditions || []} /><BulletGroup title="Invalidation" items={plan.invalidation ? [plan.invalidation] : []} /><BulletGroup title="Reasons to avoid" items={plan.reasonsToAvoid || []} />
    <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>Rule: {plan.ruleId || 'none'} · alert-only · no automatic entry, exit or order modification.</Typography>
  </>;
}

function PlanMethod({ title, text }: { title: string; text: string }) { return <Card><CardContent><Typography fontWeight={700} fontSize={14}>{title}</Typography><Typography color="text.secondary" variant="body2" mt={1}>{text}</Typography></CardContent></Card>; }
function BulletGroup({ title, items }: { title: string; items: string[] }) { return items.length ? <Box mt={1.4}><Typography className="panel-kicker">{title}</Typography><Stack spacing={0.5} mt={0.8}>{items.map((item, index) => <Typography key={index} variant="body2" color="text.secondary">• {item}</Typography>)}</Stack></Box> : null; }

const emptyTradeDraft = { side: 'buy', entryPrice: '', positionSize: '', initialStopLoss: '', tp1: '', tp2: '', thesis: '', setupType: 'other', strategyId: '', openedAt: '' };

function TradeMonitor({ refreshKey, status }: { refreshKey: number; status: MarketStatus | null }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [draft, setDraft] = useState(emptyTradeDraft);
  const [stopEdit, setStopEdit] = useState<Trade | null>(null);
  const [closeEdit, setCloseEdit] = useState<Trade | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultAmount, setResultAmount] = useState('');
  const [outcome, setOutcome] = useState('breakeven');
  const navigate = useNavigate();
  const load = useCallback(async () => {
    setLoading(true);
    const [tradeResult, alertResult] = await Promise.allSettled([api<{ trades: Trade[] }>('/trades'), api<{ alerts: AlertEvent[] }>('/alerts')]);
    if (tradeResult.status === 'fulfilled') setTrades(tradeResult.value.trades);
    else setError(tradeResult.reason instanceof Error ? tradeResult.reason.message : 'Trades unavailable');
    if (alertResult.status === 'fulfilled') setAlerts(alertResult.value.alerts.filter((alert) => alert.category === 'trade' || alert.category === 'data'));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const submitTrade = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const targets = [draft.tp1 ? { label: 'TP1', price: Number(draft.tp1) } : null, draft.tp2 ? { label: 'TP2', price: Number(draft.tp2) } : null].filter(Boolean);
      await api('/trades', json({ side: draft.side, entryPrice: Number(draft.entryPrice), positionSize: Number(draft.positionSize), initialStopLoss: Number(draft.initialStopLoss), targets, thesis: draft.thesis, setupType: draft.setupType, strategyId: draft.strategyId, ...(draft.openedAt ? { openedAt: new Date(draft.openedAt).toISOString() } : {}) }));
      setOpenForm(false); setDraft(emptyTradeDraft); navigate('/trades'); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Trade could not be registered'); }
    finally { setBusy(false); }
  };
  const updateStop = async () => {
    if (!stopEdit) return;
    setBusy(true);
    try { await api(`/trades/${stopEdit._id}/stop`, patchJson({ currentStopLoss: Number(stopEdit.currentStopLoss) })); setStopEdit(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Stop update failed'); }
    finally { setBusy(false); }
  };
  const closeTrade = async () => {
    if (!closeEdit) return;
    if (outcome !== 'breakeven' && resultAmount === '') { setError('Enter realized P/L for wins and losses so app-level daily risk checks stay meaningful.'); return; }
    setBusy(true);
    try { await api(`/trades/${closeEdit._id}/close`, json({ outcome, ...(resultAmount !== '' ? { resultMoney: Number(resultAmount) } : {}) })); setCloseEdit(null); setResultAmount(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Trade closure could not be recorded'); }
    finally { setBusy(false); }
  };

  return <Box className="page-enter"><PageTitle title="Open trade monitor" subtitle="Manually registered trades · read-only price alerts · every broker action remains manual." action={<Button variant="contained" onClick={() => setOpenForm(true)}>Register open trade</Button>} />
    <StatusBanner status={status} />{error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.3fr .7fr' }, gap: 1.5, alignItems: 'start' }}>
      <Stack spacing={1.4}>
        {loading ? <Box py={8} display="grid" sx={{ placeItems: 'center' }}><CircularProgress size={25} /></Box> : trades.length ? trades.map((trade) => <TradeCard key={trade._id} trade={trade} onEditStop={() => setStopEdit({ ...trade })} onClose={() => { setCloseEdit(trade); setOutcome('breakeven'); setResultAmount(''); }} />) : <Card><CardContent sx={{ py: 5, textAlign: 'center' }}><MonitorHeartRounded color="disabled" sx={{ fontSize: 36 }} /><Typography fontWeight={700} mt={1}>No open trades registered</Typography><Typography variant="body2" color="text.secondary" mt={0.6}>Register a trade you opened manually. This form does not send anything to MT5.</Typography><Button sx={{ mt: 2 }} onClick={() => setOpenForm(true)}>Add an open trade</Button></CardContent></Card>}
      </Stack>
      <Card><CardContent><Typography fontWeight={700} fontSize={14}>Recent monitor alerts</Typography><Typography variant="caption" color="text.secondary" display="block" mb={1.5}>Events are deduplicated by trade and threshold.</Typography>
        {alerts.length ? <Stack divider={<Divider flexItem />} spacing={1.2}>{alerts.slice(0, 12).map((item) => <Box key={item._id}><Stack direction="row" justifyContent="space-between" spacing={1}><Typography fontWeight={650} fontSize={12}>{item.title}</Typography><Typography variant="caption" color="text.secondary">{formatTime(item.triggeredAt)}</Typography></Stack><Typography variant="caption" color="text.secondary">{item.reason}</Typography></Box>)}</Stack> : <Typography variant="body2" color="text.secondary">No alerts recorded.</Typography>}
      </CardContent></Card>
    </Box>
    <Dialog open={openForm} onClose={() => setOpenForm(false)} maxWidth="sm" fullWidth><DialogTitle>Register an open trade</DialogTitle><Box component="form" onSubmit={submitTrade}><DialogContent><Stack spacing={1.5}>
      <Alert severity="info">Tracking only. This does not open, close or modify a broker order.</Alert>
      <Stack direction="row" spacing={1}><FormControl fullWidth size="small"><InputLabel>Side</InputLabel><Select label="Side" value={draft.side} onChange={(event) => setDraft({ ...draft, side: event.target.value })}><MenuItem value="buy">Buy / Long</MenuItem><MenuItem value="sell">Sell / Short</MenuItem></Select></FormControl><FormControl fullWidth size="small"><InputLabel>Setup type</InputLabel><Select label="Setup type" value={draft.setupType} onChange={(event) => setDraft({ ...draft, setupType: event.target.value })}><MenuItem value="breakout">Breakout</MenuItem><MenuItem value="retest">Retest</MenuItem><MenuItem value="other">Other</MenuItem></Select></FormControl></Stack>
      <Stack direction="row" spacing={1}><TextField label="Entry price" type="number" value={draft.entryPrice} onChange={(e) => setDraft({ ...draft, entryPrice: e.target.value })} required fullWidth inputProps={{ step: 'any' }} /><TextField label="Position size" type="number" value={draft.positionSize} onChange={(e) => setDraft({ ...draft, positionSize: e.target.value })} required fullWidth inputProps={{ min: '0', step: 'any' }} /></Stack>
      <Stack direction="row" spacing={1}><TextField label="Initial stop loss" type="number" value={draft.initialStopLoss} onChange={(e) => setDraft({ ...draft, initialStopLoss: e.target.value })} required fullWidth inputProps={{ step: 'any' }} /><TextField label="Opened at (optional)" type="datetime-local" value={draft.openedAt} onChange={(e) => setDraft({ ...draft, openedAt: e.target.value })} fullWidth InputLabelProps={{ shrink: true }} /></Stack>
      <Stack direction="row" spacing={1}><TextField label="TP1 (optional)" type="number" value={draft.tp1} onChange={(e) => setDraft({ ...draft, tp1: e.target.value })} fullWidth inputProps={{ step: 'any' }} /><TextField label="TP2 (optional)" type="number" value={draft.tp2} onChange={(e) => setDraft({ ...draft, tp2: e.target.value })} fullWidth inputProps={{ step: 'any' }} /></Stack>
      <TextField label="Trade thesis" value={draft.thesis} onChange={(e) => setDraft({ ...draft, thesis: e.target.value })} multiline minRows={2} fullWidth /><TextField label="Strategy identifier (optional)" value={draft.strategyId} onChange={(e) => setDraft({ ...draft, strategyId: e.target.value })} fullWidth />
    </Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setOpenForm(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Saving…' : 'Register for monitoring'}</Button></DialogActions></Box></Dialog>
    <Dialog open={Boolean(stopEdit)} onClose={() => setStopEdit(null)} maxWidth="xs" fullWidth><DialogTitle>Update tracking stop</DialogTitle><DialogContent><Alert severity="warning" sx={{ mb: 1.5 }}>The app records a tighter stop only. You must update MT5 yourself if your plan requires it.</Alert><TextField label="Current SL" type="number" fullWidth value={stopEdit?.currentStopLoss ?? ''} onChange={(e) => stopEdit && setStopEdit({ ...stopEdit, currentStopLoss: Number(e.target.value) })} inputProps={{ step: 'any' }} /></DialogContent><DialogActions><Button onClick={() => setStopEdit(null)}>Cancel</Button><Button variant="contained" onClick={updateStop} disabled={busy}>Save tracking level</Button></DialogActions></Dialog>
    <Dialog open={Boolean(closeEdit)} onClose={() => setCloseEdit(null)} maxWidth="xs" fullWidth><DialogTitle>Record manual trade closure</DialogTitle><DialogContent><Alert severity="info" sx={{ mb: 1.5 }}>This only closes the app record. It does not close a broker position.</Alert><Stack spacing={1.4}><FormControl fullWidth><InputLabel>Outcome</InputLabel><Select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}><MenuItem value="win">Win</MenuItem><MenuItem value="loss">Loss</MenuItem><MenuItem value="breakeven">Breakeven</MenuItem></Select></FormControl><TextField label="Realized P/L" required={outcome !== 'breakeven'} type="number" value={resultAmount} onChange={(e) => setResultAmount(e.target.value)} inputProps={{ step: 'any' }} helperText="Required for wins/losses. Use the configured account currency." /></Stack></DialogContent><DialogActions><Button onClick={() => setCloseEdit(null)}>Cancel</Button><Button variant="contained" onClick={closeTrade} disabled={busy}>Record closure</Button></DialogActions></Dialog>
  </Box>;
}

function TradeCard({ trade, onEditStop, onClose }: { trade: Trade; onEditStop: () => void; onClose: () => void }) {
  const isLong = trade.side === 'buy';
  return <Card><CardContent sx={{ p: 2.1 }}>
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'flex-start' }} spacing={1.2}>
      <Box><Stack direction="row" alignItems="center" spacing={0.7}><Box color={isLong ? 'success.main' : 'error.main'} display="flex">{isLong ? <ArrowUpwardRounded fontSize="small" /> : <ArrowDownwardRounded fontSize="small" />}</Box><Typography fontWeight={750}>{isLong ? 'BUY' : 'SELL'} · {trade.instrument}</Typography><Chip size="small" variant="outlined" label={trade.setupType} /></Stack><Typography variant="caption" color="text.secondary">Opened {formatTime(trade.openedAt)}{trade.strategyId ? ` · ${trade.strategyId}` : ''}</Typography></Box>
      <Stack direction="row" spacing={1}><Button size="small" variant="outlined" onClick={onEditStop}>Update SL</Button><Button size="small" variant="contained" color="inherit" onClick={onClose}>Record close</Button></Stack>
    </Stack>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', sm: 'repeat(4,1fr)' }, gap: 1, mt: 2 }}>
      {[['Entry', trade.entryPrice], ['Position', trade.positionSize], ['Initial SL', trade.initialStopLoss], ['Current SL', trade.currentStopLoss]].map(([label, value]) => <Box key={label} sx={{ p: 1.2, borderRadius: 1.5, bgcolor: 'rgba(255,255,255,.025)' }}><Typography className="panel-kicker">{label}</Typography><Typography className="mono" mt={0.6} fontSize={13} fontWeight={600}>{typeof value === 'number' ? price(value) : value}</Typography></Box>)}
    </Box>
    {trade.targets?.length > 0 && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mt={1.3}>{trade.targets.map((target) => <Chip key={target.label} size="small" label={`${target.label} ${price(target.price)}${target.reachedAt ? ' · reached' : ''}`} />)}</Stack>}
    {trade.thesis && <Typography variant="body2" color="text.secondary" mt={1.4}>{trade.thesis}</Typography>}
    <Typography variant="caption" color="text.secondary" display="block" mt={1.4}>No broker-side actions. Current price alerts require a fresh MT5 tick.</Typography>
  </CardContent></Card>;
}

function RiskPage({ refreshKey, status }: { refreshKey: number; status: MarketStatus | null }) {
  const [risk, setRisk] = useState<RiskStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [entry, setEntry] = useState(''); const [stop, setStop] = useState('');
  const [position, setPosition] = useState<{ positionSize: number; estimatedRisk: { amount: number; percentOfEquity: number; currency: string }; source: string } | null>(null);
  const [calcError, setCalcError] = useState('');
  const load = useCallback(async () => {
    const [r, s] = await Promise.allSettled([api<RiskStatus>('/risk/status'), api<{ settings: Settings }>('/settings')]);
    if (r.status === 'fulfilled') setRisk(r.value); if (s.status === 'fulfilled') setSettings(s.value.settings);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  const calculate = async () => { setCalcError(''); setPosition(null); try { setPosition(await api('/risk/position-size', json({ entryPrice: Number(entry), stopLoss: Number(stop) }))); } catch (e) { setCalcError(e instanceof Error ? e.message : 'Size calculation unavailable'); } };
  return <Box className="page-enter"><PageTitle title="Risk management" subtitle="Limits gate new in-app trade records. They cannot restrict broker actions." /><StatusBanner status={status} />
    {risk?.limitsBreached && <Alert severity="error" sx={{ mb: 1.5 }}>A configured daily loss or drawdown limit has been reached. Stop and review your plan.</Alert>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4,1fr)' }, gap: 1.4, mb: 1.5 }}>
      <MetricCard label="TRADES TODAY" value={String(risk?.tradesToday ?? '—')} unit={`Configured max ${risk?.configured.maxTradesPerDay ?? '—'}`} foot="Local timezone day" accent="primary.main" />
      <MetricCard label="SETUPS THIS SESSION" value={String(risk?.setupsThisSession ?? '—')} unit={`Configured max ${risk?.configured.maxSetupsPerSession ?? '—'}`} foot={marketSessionNow()} accent="info.main" />
      <MetricCard label="ACTIVE TRADES" value={String(risk?.activeTrades ?? '—')} unit={`Configured max ${risk?.configured.maxSimultaneousTrades ?? '—'}`} foot="App records only" accent="info.main" />
      <MetricCard label="CONSECUTIVE LOSSES" value={String(risk?.consecutiveLosses ?? '—')} unit={`Configured max ${risk?.configured.maxConsecutiveLosses ?? '—'}`} foot="Manual closure records" accent="warning.main" />
      <MetricCard label="REALIZED LOSS TODAY" value={risk?.riskAvailable && settings?.accountCurrency ? `${settings.accountCurrency} ${price(Math.abs(risk.realizedLossToday))}` : 'Unavailable'} unit="From recorded closures" foot={`Drawdown ${settings?.accountCurrency || ''} ${risk?.riskAvailable ? price(risk.realizedDrawdownToday) : '—'} · external P/L excluded`} accent={risk?.limitsBreached ? 'error.main' : 'text.primary'} />
    </Box>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
      <Card><CardContent><Typography fontWeight={700}>Position-size guidance</Typography><Typography variant="body2" color="text.secondary" mt={0.7}>Uses MT5 tick value/size, volume step, matching account currency and your configured equity. Guidance remains unavailable until those values are verified.</Typography>
        <Stack spacing={1.3} mt={2}><TextField label="Planned entry" type="number" value={entry} onChange={(e) => setEntry(e.target.value)} inputProps={{ step: 'any' }} /><TextField label="Planned stop loss" type="number" value={stop} onChange={(e) => setStop(e.target.value)} inputProps={{ step: 'any' }} /><Button onClick={calculate} variant="contained" disabled={!entry || !stop}>Calculate app-level guidance</Button></Stack>
        {calcError && <Alert severity="info" sx={{ mt: 1.2 }}>{calcError}</Alert>}{position && <Alert severity="success" sx={{ mt: 1.2 }}>Estimated size: <b>{position.positionSize}</b> · risk {position.estimatedRisk.currency} {price(position.estimatedRisk.amount)} ({position.estimatedRisk.percentOfEquity.toFixed(2)}%). Source: {position.source}.</Alert>}
      </CardContent></Card>
      <Card><CardContent><Typography fontWeight={700}>Limit behavior</Typography><Typography variant="body2" color="text.secondary" mt={0.7}>A new trade record is blocked when the daily trade count, simultaneous-trade cap, consecutive-loss cap, loss cooldown or recorded daily loss limit is reached.</Typography>
        <Stack spacing={1} mt={1.5}>{['No martingale or recovery sizing', 'No stop widening or removal', 'Daily P/L is based on manually recorded closed trades', 'No broker-side trade restriction'].map((item) => <Typography key={item} variant="body2" color="text.secondary">• {item}</Typography>)}</Stack>
        <Alert severity="warning" sx={{ mt: 2 }}>{risk?.note || 'Risk status is loading.'}</Alert>
      </CardContent></Card>
    </Box>
  </Box>;
}

function SettingsPage({ refreshKey }: { refreshKey: number }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => { try { const data = await api<{ settings: Settings; telegramConfigured: boolean }>('/settings'); setSettings(data.settings); setTelegramConfigured(data.telegramConfigured); } catch (e) { setError(e instanceof Error ? e.message : 'Settings unavailable'); } }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  const update = (key: keyof Settings, value: unknown) => setSettings((current) => current ? { ...current, [key]: value } : current);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!settings) return; setBusy(true); setMessage(''); setError('');
    const payload = { ...settings, ...(chatId.trim() ? { telegramChatId: chatId.trim() } : {}) };
    try { await api('/settings', patchJson(payload)); setMessage('Settings saved. Sensitive Telegram values remain server-side.'); setChatId(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Settings could not be saved'); }
    finally { setBusy(false); }
  };
  const removeTelegram = async () => { setBusy(true); try { await api('/settings', patchJson({ telegramChatId: '' })); setTelegramConfigured(false); setMessage('Telegram recipient removed.'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not remove recipient'); } finally { setBusy(false); } };
  const testTelegram = async () => { setBusy(true); setError(''); setMessage(''); try { await api('/settings/test-telegram', { method: 'POST' }); setMessage('Telegram test was delivered.'); } catch (e) { setError(e instanceof Error ? e.message : 'Telegram test failed'); } finally { setBusy(false); } };
  if (!settings) return <Stack alignItems="center" py={10}><CircularProgress size={25} /></Stack>;
  return <Box className="page-enter"><PageTitle title="Settings" subtitle="Timezone, risk policy and notification configuration." />
    {message && <Alert severity="success" sx={{ mb: 1.5 }}>{message}</Alert>}{error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    <Box component="form" onSubmit={save}><Stack spacing={1.5}>
      <Card><CardContent><Typography fontWeight={700} mb={0.5}>Display & account</Typography><Typography variant="caption" color="text.secondary">Account equity is entered by you. The application never requests MT5 passwords.</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.3} mt={2}><TextField label="Timezone" value={settings.timezone || 'Asia/Dhaka'} onChange={(e) => update('timezone', e.target.value)} helperText="IANA timezone, e.g. Asia/Dhaka" fullWidth /><TextField label="Account equity" type="number" value={settings.accountEquity ?? ''} onChange={(e) => update('accountEquity', e.target.value === '' ? undefined : Number(e.target.value))} inputProps={{ min: 0, step: 'any' }} fullWidth /><TextField label="Account currency" value={settings.accountCurrency || ''} onChange={(e) => update('accountCurrency', e.target.value.toUpperCase())} helperText="Must match collector metadata for risk calculations" fullWidth /></Stack>
      </CardContent></Card>
      <Card><CardContent><Typography fontWeight={700} mb={0.5}>Risk limits</Typography><Typography variant="caption" color="text.secondary">Changes apply to new trade records in this application only.</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4,1fr)' }, gap: 1.3, mt: 2 }}>
          {([
            ['maxRiskPercent', 'Max risk per trade %'], ['maxDailyLossPercent', 'Max daily loss %'], ['maxTradesPerDay', 'Max trade records/day'], ['maxConsecutiveLosses', 'Max consecutive losses'], ['maxDailyDrawdownPercent', 'Max daily drawdown %'], ['maxSimultaneousTrades', 'Max simultaneous trades'], ['cooldownMinutes', 'Loss cooldown minutes'], ['alertCooldownMinutes', 'Alert cooldown minutes'], ['maxSetupsPerSession', 'Max new setups/session'],
          ] as [keyof Settings, string][]).map(([key, label]) => <TextField key={key} label={label} type="number" value={settings[key] ?? 0} onChange={(e) => update(key, Number(e.target.value))} inputProps={{ min: 0, step: 'any' }} />)}
        </Box>
      </CardContent></Card>
      <Card><CardContent><Typography fontWeight={700} mb={0.5}>High-impact USD news filter</Typography><Typography variant="caption" color="text.secondary">Uses scheduled times from the optional Trading Economics calendar provider. Estimated-time events are shown as estimated and do not activate the precision window.</Typography>
        <FormControlLabel sx={{ mt: 1 }} control={<Checkbox checked={settings.newsFilterEnabled} onChange={(e) => update('newsFilterEnabled', e.target.checked)} />} label="Advise NO TRADE during configured event windows" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.3} mt={1}><TextField label="Minutes before release" type="number" value={settings.newsMinutesBefore ?? 30} onChange={(e) => update('newsMinutesBefore', Number(e.target.value))} inputProps={{ min: 0, max: 1440 }} disabled={!settings.newsFilterEnabled} /><TextField label="Minutes after release" type="number" value={settings.newsMinutesAfter ?? 15} onChange={(e) => update('newsMinutesAfter', Number(e.target.value))} inputProps={{ min: 0, max: 1440 }} disabled={!settings.newsFilterEnabled} /></Stack>
        <Alert severity="info" sx={{ mt: 1.4 }}>This changes the app's conditional setup state and sends configured reminders. It does not close, block, or modify any MT5 position.</Alert>
      </CardContent></Card>
      <Card><CardContent><Typography fontWeight={700} mb={0.5}>Telegram notifications</Typography><Typography variant="caption" color="text.secondary">The bot token is configured only as a server environment secret. Never paste it in the browser or chat.</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'center' }} spacing={1.4} mt={2}><TextField label="Telegram chat ID" value={chatId} onChange={(e) => setChatId(e.target.value)} helperText={telegramConfigured ? 'A recipient is saved. Enter a new ID to replace it.' : 'Not configured'} fullWidth /><FormControl sx={{ minWidth: 190 }}><InputLabel>Enabled</InputLabel><Select label="Enabled" value={settings.telegramEnabled ? 'yes' : 'no'} onChange={(e) => update('telegramEnabled', e.target.value === 'yes')}><MenuItem value="yes">On</MenuItem><MenuItem value="no">Off</MenuItem></Select></FormControl><FormControl sx={{ minWidth: 230 }}><InputLabel>Quiet hours timezone</InputLabel><Select label="Quiet hours timezone" value={settings.timezone || 'Asia/Dhaka'} disabled><MenuItem value={settings.timezone || 'Asia/Dhaka'}>{settings.timezone || 'Asia/Dhaka'}</MenuItem></Select></FormControl></Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mt={1.4}><TextField size="small" label="Quiet start (HH:MM)" value={settings.quietHours?.start || ''} onChange={(e) => update('quietHours', { ...settings.quietHours, start: e.target.value })} /><TextField size="small" label="Quiet end (HH:MM)" value={settings.quietHours?.end || ''} onChange={(e) => update('quietHours', { ...settings.quietHours, end: e.target.value })} /><Button variant="outlined" onClick={testTelegram} disabled={busy || !telegramConfigured}>Send test notification</Button>{telegramConfigured && <Button color="error" onClick={removeTelegram} disabled={busy}>Remove recipient</Button>}</Stack>
        <Stack direction="row" flexWrap="wrap" useFlexGap mt={1.2}>{[['trade', 'Trade'], ['data', 'Data'], ['system', 'System'], ['news', 'News']].map(([key, label]) => <FormControlLabel key={key} control={<Checkbox size="small" checked={settings.notificationCategories?.includes(key) || false} onChange={(e) => update('notificationCategories', e.target.checked ? [...(settings.notificationCategories || []), key] : (settings.notificationCategories || []).filter((item) => item !== key))} />} label={<Typography variant="caption">{label} alerts</Typography>} />)}</Stack>
        <Alert severity="info" sx={{ mt: 1.5 }}>Delivery attempts are recorded. Telegram uses at most three attempts with increasing delays. Quiet hours are interpreted in the selected IANA timezone.</Alert>
      </CardContent></Card>
      <Stack direction="row" justifyContent="flex-end"><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button></Stack>
    </Stack></Box>
  </Box>;
}

function HistoryPage() {
  const [data, setData] = useState<AnalysisResponse | null>(null); const [status, setStatus] = useState<MarketStatus | null>(null); const [error, setError] = useState('');
  useEffect(() => { Promise.all([api<AnalysisResponse>('/market/analysis'), api<MarketStatus>('/market/status')]).then(([analysis, market]) => { setData(analysis); setStatus(market); }).catch((issue) => setError(issue instanceof Error ? issue.message : 'Historical analysis unavailable')); }, []);
  const daily = data?.results.D1?.liquidity?.periods?.day; const weekly = data?.results.D1?.liquidity?.periods?.week; const monthly = data?.results.D1?.liquidity?.periods?.month;
  const sessions = data?.results.M5?.liquidity?.sessions || [];
  return <Box className="page-enter"><PageTitle title="Historical analysis" subtitle="Previous period references and session ranges from stored closed candles." /><StatusBanner status={status} />
    {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    {status?.mode === 'illustrative' && <Alert severity="warning" sx={{ mb: 1.5 }}>This view is using clearly labelled synthetic test candles, not broker history.</Alert>}
    <Card><CardContent><Typography fontWeight={700}>Previous day</Typography>{daily ? <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4,1fr)' }, gap: 1.3, mt: 1.6 }}>{[['High', daily.high], ['Low', daily.low], ['Open', daily.open], ['Close', daily.close]].map(([label, value]) => <MetricCard key={label} label={`PREVIOUS DAY ${String(label).toUpperCase()}`} value={price(Number(value))} unit={`${daily.period} · ${formatTime(daily.from)}`} foot="Completed daily candles" accent="text.primary" />)}</Box> : <Typography color="text.secondary" mt={1}>Insufficient daily history.</Typography>}</CardContent></Card>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.4, mt: 1.4 }}>
      <PeriodRangeCard title="Previous week" period={weekly} />
      <PeriodRangeCard title="Previous month" period={monthly} />
    </Box>
    <Card sx={{ mt: 1.4 }}><CardContent><Typography fontWeight={700}>Most recent session ranges</Typography><Typography variant="caption" color="text.secondary" display="block" mt={0.4}>Defaults: Asia 00–08 Singapore, London 08–17 Europe/London, New York 08–17 America/New_York. IANA timezones handle DST; window boundaries are configurable analysis conventions.</Typography>
      {sessions.length ? <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2} mt={1.4}>{sessions.map((session) => <Box key={`${session.session}-${session.date}`} sx={{ flex: 1, p: 1.3, borderRadius: 1.5, bgcolor: 'rgba(255,255,255,.025)', border: '1px solid', borderColor: 'divider' }}><Typography fontWeight={650}>{session.session.replaceAll('_', ' ')} · {session.date}</Typography><Typography className="mono" variant="body2" mt={0.7}>High {price(session.high)} · Low {price(session.low)}</Typography><Typography variant="caption" color="text.secondary">{session.timezone} · {formatTime(session.from)} — {formatTime(session.to)}</Typography></Box>)}</Stack> : <Typography color="text.secondary" mt={1}>Insufficient intraday candles for session ranges.</Typography>}
    </CardContent></Card>
    <Alert severity="info" sx={{ mt: 1.5 }}>The current backtester evaluates its documented breakout and retest rules on stored provider candles. Historical reactions to economic-news events are not implemented; no news reaction statistics are inferred.</Alert>
  </Box>;
}

function PeriodRangeCard({ title, period }: { title: string; period?: { period: string; high: number; low: number } }) {
  return <Card><CardContent><Typography fontWeight={700}>{title}</Typography>{period ? <Stack direction="row" spacing={1} mt={1.2}><MetricCard label="HIGH" value={price(period.high)} unit={period.period} foot="Closed D1 candle aggregate" accent="error.main" /><MetricCard label="LOW" value={price(period.low)} unit={period.period} foot="Closed D1 candle aggregate" accent="success.main" /></Stack> : <Typography color="text.secondary" mt={1}>Insufficient D1 coverage.</Typography>}</CardContent></Card>;
}

function NewsPage() {
  const [data, setData] = useState<{ configured: boolean; provider: string | null; events: NewsEvent[]; lastProviderUpdateAt: string | null; lastSyncAttemptAt: string | null; lastSyncError: string | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<{ configured: boolean; provider: string | null; events: NewsEvent[]; lastProviderUpdateAt: string | null; lastSyncAttemptAt: string | null; lastSyncError: string | null }>('/news').then(setData).catch((issue) => setError(issue instanceof Error ? issue.message : 'Calendar unavailable')); }, []);
  return <Box className="page-enter"><PageTitle title="News & events" subtitle="High-impact USD calendar values from the configured provider; timestamps display in Asia/Dhaka." />
    {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    {!data?.configured && <Alert severity="warning" icon={<EventNoteRounded />} sx={{ mb: 1.5 }}>No Trading Economics API key is configured. Consensus, actual values and upcoming event times remain unavailable; no events are fabricated.</Alert>}
    {data?.configured && <Alert severity={data.lastSyncError ? 'warning' : 'info'} sx={{ mb: 1.5 }}>Provider: Trading Economics · last successful sync {formatTime(data.lastProviderUpdateAt)}{data.lastSyncAttemptAt ? ` · last attempt ${formatTime(data.lastSyncAttemptAt)}` : ''}{data.lastSyncError ? ` · ${data.lastSyncError}` : ''}. Event times are supplied in UTC.</Alert>}
    {data?.events.length ? <Stack spacing={1.2}>{data.events.map((event) => <Card key={event.eventId}><CardContent><Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}><Box><Stack direction="row" spacing={0.8} alignItems="center"><Chip size="small" color="error" label="HIGH IMPACT" /><Typography fontWeight={700}>{event.name}</Typography></Stack><Typography variant="body2" color="text.secondary" mt={0.7}>{event.country} · {event.currency} · {event.dateSpan === 0 ? 'Scheduled time' : 'Date/time estimated'} · {formatTime(event.scheduledAt)}</Typography></Box>{event.sourceURL && <Button component="a" href={event.sourceURL} target="_blank" rel="noreferrer" size="small">Provider detail</Button>}</Stack>
      <Stack direction="row" flexWrap="wrap" useFlexGap gap={1.2} mt={1.4}>{[['Actual', event.actual], ['Consensus', event.forecast], ['Previous', event.previous]].map(([label, value]) => <Typography key={String(label)} variant="body2" color="text.secondary">{label}: <b>{value || 'Not reported'}</b></Typography>)}</Stack>
      {event.source && <Typography variant="caption" color="text.secondary" display="block" mt={0.8}>Source: {event.source} · provider update {formatTime(event.lastProviderUpdateAt)}</Typography>}
    </CardContent></Card>)}</Stack> : data?.configured && <Card><CardContent><Typography color="text.secondary">No high-impact USD events are available in the selected date range.</Typography></CardContent></Card>}
    <Alert severity="info" sx={{ mt: 1.5 }}>Pre-event reminders and the optional NO TRADE window use exact-time high-impact USD events. Estimated-time events are displayed but do not activate the precision filter. Calendar data does not predict the XAUUSD reaction; no DXY or Treasury-yield feed is connected.</Alert>
  </Box>;
}

type BacktestMetrics = { totalTrades: number; winRatePercent: number | null; averageWinR: number | null; averageLossR: number | null; expectancyR: number | null; profitFactor: number | null; maxDrawdownR: number; netR: number; averageHoldingBars: number | null; sampleSize: number };
type BacktestResult = { runId: string; strategy: string; ruleId: string; configuration: Record<string, number>; sourceRange: { from: string; to: string; candles: number; splitAt: string }; train: BacktestMetrics; outOfSample: BacktestMetrics; bySession: Record<string, BacktestMetrics>; byRegime: Record<string, BacktestMetrics>; sensitivityByRewardRisk: Record<string, BacktestMetrics>; trades: { entryAt: string; exitAt: string; side: string; entry: number; exit: number; resultR: number; exitReason: string; session: string }[]; limitations: string[] };
function BacktestingPage() {
  const [strategy, setStrategy] = useState('breakout'); const [timeframe, setTimeframe] = useState('M15');
  const [trainFraction, setTrainFraction] = useState(0.7); const [stopAtr, setStopAtr] = useState(1); const [rewardRisk, setRewardRisk] = useState(2);
  const [spreadPrice, setSpreadPrice] = useState(0); const [slippagePrice, setSlippagePrice] = useState(0); const [commissionPrice, setCommissionPrice] = useState(0);
  const [result, setResult] = useState<BacktestResult | null>(null); const [runs, setRuns] = useState<{ _id: string; strategy: { name?: string; timeframe?: string }; metrics: { outOfSample?: BacktestMetrics }; sourceRange: { from: string; to: string }; completedAt: string }[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const loadHistory = useCallback(() => { api<{ runs: typeof runs }>('/backtesting/history').then((value) => setRuns(value.runs)).catch(() => {}); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  const run = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const value = await api<BacktestResult>('/backtesting/run', json({ strategy, timeframe, trainFraction, stopAtr, rewardRisk, spreadPrice, slippagePrice, commissionPrice, limit: 2000 })); setResult(value); loadHistory(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Backtest could not be completed'); }
    finally { setBusy(false); }
  };
  const metrics = result?.outOfSample;
  return <Box className="page-enter"><PageTitle title="Backtesting" subtitle="Reproducible rules on stored provider candles, with chronological holdout and explicit costs." />
    <Alert severity="warning" sx={{ mb: 1.5 }}>Research only. This simple 20-bar breakout/retest rule is not a trading recommendation. It runs only on stored provider data, never synthetic candles. Cost inputs use XAUUSD price units.</Alert>
    {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    <Card><CardContent><Typography fontWeight={700}>Strategy assumptions</Typography><Box component="form" onSubmit={run}><Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4,1fr)' }, gap: 1.3, mt: 1.7 }}>
      <FormControl><InputLabel>Setup</InputLabel><Select label="Setup" value={strategy} onChange={(e) => setStrategy(e.target.value)}><MenuItem value="breakout">Close breakout</MenuItem><MenuItem value="retest">Breakout retest</MenuItem></Select></FormControl>
      <FormControl><InputLabel>Timeframe</InputLabel><Select label="Timeframe" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>{['M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
      <TextField label="Train fraction" type="number" value={trainFraction} onChange={(e) => setTrainFraction(Number(e.target.value))} inputProps={{ min: 0.5, max: 0.9, step: 0.05 }} />
      <TextField label="Stop distance (ATR)" type="number" value={stopAtr} onChange={(e) => setStopAtr(Number(e.target.value))} inputProps={{ min: 0.1, max: 10, step: 0.1 }} />
      <TextField label="Reward/risk target" type="number" value={rewardRisk} onChange={(e) => setRewardRisk(Number(e.target.value))} inputProps={{ min: 0.1, max: 10, step: 0.1 }} />
      <TextField label="Round-trip spread cost" type="number" value={spreadPrice} onChange={(e) => setSpreadPrice(Number(e.target.value))} inputProps={{ min: 0, step: 0.01 }} />
      <TextField label="Slippage per side" type="number" value={slippagePrice} onChange={(e) => setSlippagePrice(Number(e.target.value))} inputProps={{ min: 0, step: 0.01 }} />
      <TextField label="Round-trip commission" type="number" value={commissionPrice} onChange={(e) => setCommissionPrice(Number(e.target.value))} inputProps={{ min: 0, step: 0.01 }} />
    </Box><Stack direction="row" justifyContent="space-between" alignItems="center" mt={1.5}><Typography variant="caption" color="text.secondary">Signal at candle close · entry at next open · stop-first when both exit levels trade in one candle.</Typography><Button type="submit" variant="contained" startIcon={<ScienceRounded />} disabled={busy}>{busy ? 'Running…' : 'Run backtest'}</Button></Stack></Box></CardContent></Card>
    {result && metrics && <Stack spacing={1.4} mt={1.5}>
      <Card><CardContent><Typography fontWeight={700}>Out-of-sample results</Typography><Typography variant="caption" color="text.secondary" display="block" mt={0.4}>{result.strategy} · {result.sourceRange.candles} candles · {formatTime(result.sourceRange.from)} — {formatTime(result.sourceRange.to)} · test starts {formatTime(result.sourceRange.splitAt)} · sample {metrics.sampleSize}</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4,1fr)' }, gap: 1.2, mt: 1.7 }}>
          <MetricCard label="NET RESULT" value={`${metrics.netR.toFixed(2)} R`} unit="After configured cost assumptions" foot="Out-of-sample only" accent={metrics.netR >= 0 ? 'success.main' : 'error.main'} />
          <MetricCard label="WIN RATE" value={metrics.winRatePercent === null ? '—' : `${metrics.winRatePercent.toFixed(1)}%`} unit="Closed test trades" foot={`n = ${metrics.sampleSize}`} accent="text.primary" />
          <MetricCard label="EXPECTANCY" value={metrics.expectancyR === null ? '—' : `${metrics.expectancyR.toFixed(3)} R`} unit="Mean net R per trade" foot="Same assumed strategy rules" accent="text.primary" />
          <MetricCard label="MAX DRAWDOWN" value={`${metrics.maxDrawdownR.toFixed(2)} R`} unit="Peak-to-trough cumulative R" foot={`Profit factor ${metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)}`} accent="warning.main" />
        </Box>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} mt={2}><Box flex={1}><Typography fontWeight={650} fontSize={13}>Sensitivity by target</Typography>{Object.entries(result.sensitivityByRewardRisk).map(([key, value]) => <Typography key={key} variant="body2" color="text.secondary" mt={0.7}>{key}: {value.totalTrades} trades · {value.netR.toFixed(2)} R net · {value.expectancyR === null ? '—' : `${value.expectancyR.toFixed(3)} R expectancy`}</Typography>)}</Box><Box flex={1}><Typography fontWeight={650} fontSize={13}>Results by session</Typography>{Object.entries(result.bySession).map(([key, value]) => <Typography key={key} variant="body2" color="text.secondary" mt={0.7}>{key}: n={value.sampleSize} · {value.netR.toFixed(2)} R</Typography>)}</Box><Box flex={1}><Typography fontWeight={650} fontSize={13}>Results by regime</Typography>{Object.entries(result.byRegime).map(([key, value]) => <Typography key={key} variant="body2" color="text.secondary" mt={0.7}>{key}: n={value.sampleSize} · {value.netR.toFixed(2)} R</Typography>)}</Box></Stack>
        <Typography variant="caption" color="text.secondary" display="block" mt={1.4}>Train sample: n={result.train.totalTrades}, net {result.train.netR.toFixed(2)} R · Rule {result.ruleId}</Typography>
      </CardContent></Card>
      {result.trades.length > 0 && <Card><CardContent><Typography fontWeight={700}>Out-of-sample trades ({result.trades.length})</Typography><Stack spacing={0.7} mt={1.1}>{result.trades.slice(-12).reverse().map((trade, index) => <Stack key={`${trade.entryAt}-${index}`} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" sx={{ p: 1, borderRadius: 1, bgcolor: 'rgba(255,255,255,.025)' }}><Typography variant="body2">{trade.side.toUpperCase()} · {formatTime(trade.entryAt)} · {price(trade.entry)} → {price(trade.exit)}</Typography><Typography variant="caption" color={trade.resultR >= 0 ? 'success.main' : 'error.main'}>{trade.resultR.toFixed(2)} R · {trade.exitReason} · {trade.session}</Typography></Stack>)}</Stack></CardContent></Card>}
      <Alert severity="info">{result.limitations.join(' ')}</Alert>
    </Stack>}
    <Card sx={{ mt: 1.5 }}><CardContent><Typography fontWeight={700}>Saved runs</Typography>{runs.length ? <Stack spacing={0.6} mt={1}>{runs.map((saved) => <Typography key={saved._id} variant="body2" color="text.secondary">{saved.strategy.name} · {saved.strategy.timeframe} · {formatTime(saved.completedAt)} · n={saved.metrics.outOfSample?.sampleSize ?? 0} · {saved.metrics.outOfSample?.netR?.toFixed(2) ?? '—'} R</Typography>)}</Stack> : <Typography variant="body2" color="text.secondary" mt={0.6}>No completed backtests yet. A provider dataset with at least 80 candles is required.</Typography>}</CardContent></Card>
  </Box>;
}

type JournalEntry = { _id: string; notes: string; tags: string[]; createdAt: string };
function JournalPage({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]); const [notes, setNotes] = useState(''); const [tags, setTags] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const result = await api<{ entries: JournalEntry[] }>('/journal'); setEntries(result.entries); } catch (e) { setError(e instanceof Error ? e.message : 'Journal unavailable'); } }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api('/journal', json({ notes, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) })); setNotes(''); setTags(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Entry could not be saved'); } finally { setBusy(false); } };
  const remove = async (id: string) => { try { await api(`/journal/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Entry could not be deleted'); } };
  return <Box className="page-enter"><PageTitle title="Trade journal" subtitle="Private execution notes and review records for your account." />{error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    <Card><CardContent><Typography fontWeight={700}>New journal entry</Typography><Box component="form" onSubmit={save}><Stack spacing={1.3} mt={1.5}><TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} minRows={3} multiline required /><TextField label="Tags (comma-separated)" value={tags} onChange={(e) => setTags(e.target.value)} /><Button type="submit" variant="contained" sx={{ alignSelf: 'flex-end' }} disabled={busy}>{busy ? 'Saving…' : 'Save entry'}</Button></Stack></Box></CardContent></Card>
    <Stack spacing={1.2} mt={1.5}>{entries.map((entry) => <Card key={entry._id}><CardContent><Stack direction="row" justifyContent="space-between" alignItems="flex-start"><Typography variant="caption" color="text.secondary">{formatTime(entry.createdAt)}</Typography><Button size="small" color="error" onClick={() => remove(entry._id)}>Delete</Button></Stack><Typography whiteSpace="pre-wrap" mt={1}>{entry.notes}</Typography><Stack direction="row" spacing={0.6} mt={1}>{entry.tags.map((tag) => <Chip key={tag} size="small" label={tag} />)}</Stack></CardContent></Card>)}{!entries.length && <Typography color="text.secondary" textAlign="center" py={3}>No journal entries yet.</Typography>}</Stack>
  </Box>;
}

