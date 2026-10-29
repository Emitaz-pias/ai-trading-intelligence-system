import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography } from '@mui/material';
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { AnalysisResult, Candle, SupplyDemandZone, Trade } from '../types';

function chartTime(value: string): UTCTimestamp { return Math.floor(new Date(value).getTime() / 1000) as UTCTimestamp; }
function displayTime(value: Time): string {
  const date = new Date(typeof value === 'number' ? value * 1000 : String(value));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function MarketChart({ candles, analysis, trades, timeframe, symbol, sourceMode, referencePrice }: { candles: Candle[]; analysis?: AnalysisResult; trades: Trade[]; timeframe: string; symbol: string; sourceMode: string; referencePrice?: number | null }) {
  const root = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);
  const [showSwings, setShowSwings] = useState(true);
  const [showStructure, setShowStructure] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [showSupplyDemand, setShowSupplyDemand] = useState(true);
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [selectedZone, setSelectedZone] = useState<SupplyDemandZone | null>(null);
  const [crosshair, setCrosshair] = useState<{ time: string; open: number; high: number; low: number; close: number } | null>(null);

  useEffect(() => {
    if (!root.current) return;
    const instance = createChart(root.current, {
      width: root.current.clientWidth, height: 440,
      layout: { background: { type: ColorType.Solid, color: '#111a22' }, textColor: '#8b9aa7', fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: 'rgba(143,162,178,.07)' }, horzLines: { color: 'rgba(143,162,178,.07)' } },
      crosshair: { mode: 0, vertLine: { color: 'rgba(73,212,179,.42)', width: 1, style: LineStyle.Dashed }, horzLine: { color: 'rgba(73,212,179,.42)', width: 1, style: LineStyle.Dashed } },
      rightPriceScale: { borderColor: 'rgba(143,162,178,.14)', scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: 'rgba(143,162,178,.14)', timeVisible: true, secondsVisible: false, rightOffset: 5 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const candle = instance.addSeries(CandlestickSeries, {
      upColor: '#49d4b3', downColor: '#ff737d', borderUpColor: '#49d4b3', borderDownColor: '#ff737d',
      wickUpColor: '#49d4b3', wickDownColor: '#ff737d', priceLineVisible: false,
    });
    const volume = instance.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    chart.current = instance; candleSeries.current = candle; volumeSeries.current = volume; markers.current = createSeriesMarkers(candle, []);
    const observer = new ResizeObserver((entries) => { const width = entries[0]?.contentRect.width; if (width && width > 0) instance.applyOptions({ width }); });
    observer.observe(root.current);
    instance.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(candle);
      if (!bar || !param.time || !('open' in bar)) { setCrosshair(null); return; }
      setCrosshair({ time: displayTime(param.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    });
    const refreshOverlays = () => setOverlayRevision((revision) => revision + 1);
    instance.timeScale().subscribeVisibleLogicalRangeChange(refreshOverlays);
    return () => { observer.disconnect(); instance.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverlays); instance.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; markers.current = null; };
  }, []);

  const bars = useMemo(() => candles.filter((bar) => Number.isFinite(Date.parse(bar.time)) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)), [candles]);
  useEffect(() => {
    const instance = chart.current, candle = candleSeries.current, volume = volumeSeries.current;
    if (!instance || !candle || !volume || !bars.length) return;
    candle.setData(bars.map((bar) => ({ time: chartTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    volume.setData(bars.map((bar) => ({ time: chartTime(bar.time), value: bar.volume || 0, color: bar.close >= bar.open ? 'rgba(73,212,179,.30)' : 'rgba(255,115,125,.30)' })));
    instance.timeScale().fitContent();
  }, [bars]);

  const supplyDemandRects = useMemo(() => {
    if (!showSupplyDemand || !chart.current || !candleSeries.current || !root.current) return [];
    const width = root.current.clientWidth;
    return (analysis?.supplyDemand || []).slice(-10).flatMap((zone) => {
      const start = chart.current?.timeScale().timeToCoordinate(chartTime(zone.baseFrom));
      const end = chart.current?.timeScale().timeToCoordinate(chartTime(bars.at(-1)?.time || zone.displacementAt));
      const high = candleSeries.current?.priceToCoordinate(zone.high);
      const low = candleSeries.current?.priceToCoordinate(zone.low);
      if (start === null || start === undefined || end === null || end === undefined || high === null || high === undefined || low === null || low === undefined) return [];
      const left = Math.max(0, Math.min(start, end)); const right = Math.min(width, Math.max(start, end));
      if (right <= left) return [];
      return [{ zone, left, top: Math.max(0, Math.min(high, low)), width: right - left, height: Math.max(2, Math.abs(high - low)) }];
    });
  }, [analysis?.supplyDemand, bars, showSupplyDemand, overlayRevision]);

  useEffect(() => {
    const candle = candleSeries.current;
    if (!candle || !markers.current) return;
    for (const line of lines.current) candle.removePriceLine(line);
    lines.current = [];
    const output: { time: UTCTimestamp; position: 'aboveBar' | 'belowBar' | 'inBar'; color: string; shape: 'circle' | 'arrowUp' | 'arrowDown'; text: string; size: number }[] = [];
    if (showSwings) for (const swing of analysis?.swings || []) output.push({ time: chartTime(swing.confirmedAt), position: swing.kind === 'swing_high' ? 'aboveBar' : 'belowBar', color: swing.kind === 'swing_high' ? '#f5bd63' : '#49d4b3', shape: swing.kind === 'swing_high' ? 'arrowDown' : 'arrowUp', text: swing.label, size: 1 });
    if (showStructure) for (const event of analysis?.structure || []) output.push({ time: chartTime(event.time), position: event.direction === 'up' ? 'belowBar' : 'aboveBar', color: event.direction === 'up' ? '#49d4b3' : '#ff737d', shape: event.direction === 'up' ? 'arrowUp' : 'arrowDown', text: event.type, size: 1 });
    output.sort((a, b) => a.time - b.time);
    markers.current.setMarkers(output.slice(-80));
    const addLine = (price: number, color: string, title: string, style = LineStyle.Dashed) => lines.current.push(candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    if (Number.isFinite(referencePrice) && (referencePrice as number) > 0) addLine(referencePrice as number, 'rgba(105,178,255,.92)', 'Indicative spot · separate source', LineStyle.Solid);
    if (showZones) {
      if (analysis?.nearestSupport) { addLine(analysis.nearestSupport.low, 'rgba(73,212,179,.60)', 'Support low'); addLine(analysis.nearestSupport.high, 'rgba(73,212,179,.60)', 'Support high'); }
      if (analysis?.nearestResistance) { addLine(analysis.nearestResistance.low, 'rgba(255,115,125,.60)', 'Resistance low'); addLine(analysis.nearestResistance.high, 'rgba(255,115,125,.60)', 'Resistance high'); }
    }
    if (showLiquidity) for (const level of (analysis?.liquidity?.levels || []).filter((item) => item.type.startsWith('previous_') || item.type.startsWith('equal_')).slice(-10)) {
      addLine(level.price, level.potentialSweepAt ? 'rgba(245,189,99,.8)' : 'rgba(245,189,99,.42)', `Liquidity · ${level.type.replaceAll('_', ' ')}${level.potentialSweepAt ? ' · swept?' : ''}`);
    }
    if (showTrades) for (const trade of trades) {
      if (trade.instrument !== symbol || trade.status !== 'open') continue;
      addLine(trade.entryPrice, '#d9e4ec', `${trade.side.toUpperCase()} entry`, LineStyle.Solid);
      addLine(trade.currentStopLoss, '#ff737d', 'Manual SL', LineStyle.LargeDashed);
      for (const target of trade.targets || []) addLine(target.price, '#49d4b3', target.label, LineStyle.LargeDashed);
    }
  }, [analysis, trades, showSwings, showStructure, showZones, showLiquidity, showTrades, referencePrice]);

  return <Box>
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={0.8} mb={1.3}>
      <Stack direction="row" alignItems="center" spacing={1}><Typography fontWeight={750}>{symbol}</Typography><Typography className="mono" color="text.secondary" fontSize={11}>{timeframe}</Typography><Typography variant="caption" color="text.secondary">{sourceMode === 'illustrative' ? 'SYNTHETIC' : sourceMode === 'provider' ? 'BROKER CANDLES' : sourceMode === 'xaus' ? 'INDICATIVE · XAUS' : 'NO FEED'}</Typography></Stack>
      {crosshair && <Typography className="mono" variant="caption" color="text.secondary">{crosshair.time} · O {crosshair.open.toFixed(2)} H {crosshair.high.toFixed(2)} L {crosshair.low.toFixed(2)} C {crosshair.close.toFixed(2)}</Typography>}
    </Stack>
    <Box sx={{ position: 'relative' }}><Box ref={root} sx={{ width: '100%', minHeight: 440, '& canvas': { display: 'block' } }} />
      {supplyDemandRects.map(({ zone, left, top, width, height }) => <Box key={`${zone.ruleId}-${zone.baseFrom}`} role="button" tabIndex={0} aria-label={`${zone.type} zone ${zone.status}`} onClick={() => setSelectedZone(zone)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedZone(zone); }} title={`${zone.type} ${zone.status} · click for rule`} sx={{ position: 'absolute', left, top, width, height, zIndex: 2, cursor: 'pointer', border: `1px solid ${zone.type === 'demand' ? 'rgba(73,212,179,.85)' : 'rgba(255,115,125,.85)'}`, background: zone.type === 'demand' ? 'rgba(73,212,179,.14)' : 'rgba(255,115,125,.14)' }} />)}
    </Box>
    <Stack direction="row" flexWrap="wrap" useFlexGap gap={0.2} mt={1}><FormControlLabel control={<Checkbox size="small" checked={showSwings} onChange={(e) => setShowSwings(e.target.checked)} />} label={<Typography variant="caption">Confirmed swings</Typography>} /><FormControlLabel control={<Checkbox size="small" checked={showStructure} onChange={(e) => setShowStructure(e.target.checked)} />} label={<Typography variant="caption">BOS / CHoCH</Typography>} /><FormControlLabel control={<Checkbox size="small" checked={showZones} onChange={(e) => setShowZones(e.target.checked)} />} label={<Typography variant="caption">Support / resistance</Typography>} /><FormControlLabel control={<Checkbox size="small" checked={showSupplyDemand} onChange={(e) => setShowSupplyDemand(e.target.checked)} />} label={<Typography variant="caption">Supply / demand</Typography>} /><FormControlLabel control={<Checkbox size="small" checked={showLiquidity} onChange={(e) => setShowLiquidity(e.target.checked)} />} label={<Typography variant="caption">Liquidity levels</Typography>} /><FormControlLabel control={<Checkbox size="small" checked={showTrades} onChange={(e) => setShowTrades(e.target.checked)} />} label={<Typography variant="caption">Registered trades</Typography>} /></Stack>
    <Dialog open={Boolean(selectedZone)} onClose={() => setSelectedZone(null)} maxWidth="sm" fullWidth><DialogTitle>{selectedZone?.type.toUpperCase()} zone · {selectedZone?.status?.replaceAll('_', ' ')}</DialogTitle><DialogContent><Typography variant="body2" color="text.secondary">Base {selectedZone ? displayTime(chartTime(selectedZone.baseFrom)) : '—'}–{selectedZone ? displayTime(chartTime(selectedZone.baseTo)) : '—'}; closed displacement at {selectedZone ? displayTime(chartTime(selectedZone.displacementAt)) : '—'}. Bounds {selectedZone ? `${selectedZone.low.toFixed(2)}–${selectedZone.high.toFixed(2)}` : '—'}. Retests: {selectedZone?.tests ?? 0}. {selectedZone?.invalidation}</Typography><Typography variant="caption" display="block" color="text.secondary" mt={1}>Candidate only. Rule ID · {selectedZone?.ruleId}. A supply or demand zone does not guarantee a reversal.</Typography></DialogContent><DialogActions><Button onClick={() => setSelectedZone(null)}>Close</Button></DialogActions></Dialog>
    <Typography variant="caption" color="text.secondary">All timestamps stored in UTC; chart times display in Asia/Dhaka. Zone bounds and event markers come from the deterministic analysis rule IDs.</Typography>
  </Box>;
}
