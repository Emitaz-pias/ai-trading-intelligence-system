# AI Trading Intelligence System — implementation plan

## Repository and integration findings

- The checkout was empty (no application files, dependencies, or existing tests).
- Node.js 22 is installed. The desktop workspace's bundled Python 3.12 runtime is available; a system Python command is not on PATH.
- No MetaTrader terminal process or installed terminal directory was found on this development machine, so no FundingPips account or live feed can be verified here.
- FundingPips' published MT5 guide lists the `FundingPips-SIM1` and `FundingPips2-SIM` servers and says investor credentials are view-only. The official MetaTrader Python bridge connects through a locally installed/running desktop terminal and can read rates, ticks, symbols and positions. The Windows VPS collector can therefore use this documented route if the user's assigned server/account can log in. Live compatibility remains unverified until the collector's read-only self-check runs on that VPS.
- The collector will only read market/account data. It will not call order placement or modification APIs.

## Phases and boundaries

1. **Foundation and data status — implemented:** React/Vite/MUI dashboard, Express API, MongoDB persistence, authenticated user boundary, WebSocket status/events, provider-neutral candle contract, and a visibly labelled illustrative development feed. Production starts without a live feed and cannot label stale data as live.
2. **Deterministic analysis — implemented:** isolated Python service for confirmed pivots, HH/HL/LH/LL, close-confirmed BOS/CHoCH, trend/range/volatility context, explainable support/resistance and supply/demand zones, higher-timeframe levels, liquidity references and session ranges. Candle timestamps are UTC; swings are emitted only after right-side confirmation.
3. **Conditional plans and manual monitoring — implemented:** setup states and rule conditions derived from actual stored candles; authenticated manual trade registration; price-triggered alert events with deduplication and bounded delivery records; optional provider calendar reminders and exact-time news filter. No broker execution.
4. **Read-only MT5 bridge and operations — implemented, account verification pending:** Windows VPS collector with connection/freshness/reconnect/gap checks, authenticated cloud ingestion, Docker deployment, setup and recovery documentation. Account/server integration must be checked against the user's assigned FundingPips credentials on the VPS without requesting secrets in chat.
5. **Research backtesting — implemented:** deterministic breakout/retest backtests on stored provider candles with chronological train/out-of-sample split, explicit costs, conservative stop-first resolution, and saved result records.

## Service contracts

- **Collector → API:** `POST /api/collector/ingest` with an environment-configured bearer secret, source identity, UTC candle/tick timestamps, provider symbol metadata and health state. API rejects malformed, duplicate or excessively old/future data; candles are upserted on `(provider,symbol,timeframe,time)`.
- **API → analysis:** JSON containing instrument, timeframe and sorted UTC OHLCV bars. Python returns deterministic, versioned findings with rule IDs, source candle times, confirmation times, invalidation conditions and confidence limitations.
- **Web client → API:** cookie-authenticated REST endpoints for candles, analyses, settings, trades and alert history. `/ws` uses the same session cookie and emits persisted market/alert events.
- **Data modes:** `illustrative` is development-only and all values/outputs carry that provenance. `provider` requires a healthy collector and sufficiently fresh data. The UI shows stale/disconnected states rather than reusing an old close as a current quote.
- **Calendar provider → API:** optional Trading Economics U.S. high-impact calendar polling uses a server-only API key. Provider timestamps are handled as UTC; events without a precise scheduled time are shown as estimated and excluded from exact-time filtering. The filter is opt-in per user and changes only the app's conditional plan state.

## Known limitations until integration verification

- This environment cannot prove the actual FundingPips login, assigned server, exact XAUUSD symbol alias, symbol contract specification, account permissions, or broker feed cadence.
- Calendar integration is implemented, but no Trading Economics key is present in this environment, so provider authentication and live event sync remain unverified. Historical news-reaction tests and DXY/Treasury-yield feeds are not included.
- Position-size guidance remains unavailable until symbol tick value/size and the user's account currency/equity are confirmed from source metadata/settings.
- Historical performance and backtest statistics require stored provider candles and explicit strategy assumptions; illustrative data is excluded from production results. Current backtest rules are simple research tools and do not establish profitability.
