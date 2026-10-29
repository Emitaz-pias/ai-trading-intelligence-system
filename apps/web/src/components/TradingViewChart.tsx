import { useEffect, useRef } from 'react';

export default function TradingViewChart({ interval }: { interval: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    host.replaceChildren();
    const chart = document.createElement('div');
    chart.className = 'tradingview-widget-container__widget';
    chart.style.width = '100%';
    chart.style.height = 'calc(100% - 32px)';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: 'OANDA:XAUUSD',
      interval,
      timezone: 'Asia/Dhaka',
      theme: 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });

    const attribution = document.createElement('div');
    attribution.className = 'tradingview-widget-copyright';
    attribution.style.fontSize = '12px';
    const link = document.createElement('a');
    link.href = 'https://www.tradingview.com/symbols/XAUUSD/?exchange=OANDA';
    link.target = '_blank';
    link.rel = 'noopener nofollow';
    link.textContent = 'Gold Spot / U.S. Dollar chart by TradingView';
    attribution.append(link);

    host.append(chart, script, attribution);
    return () => host.replaceChildren();
  }, [interval]);

  return <div ref={hostRef} className="tradingview-widget-container" style={{ width: '100%', height: 'min(68vh, 760px)', minHeight: 460 }} />;
}
