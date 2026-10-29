# AI Trading Intelligence System

A public XAUUSD chart and rule-based analysis view, with a private workspace for trade records. The public chart uses indicative reference OHLC data; it can differ from OANDA or FundingPips. Reference-feed mode always shows `NO_TRADE` because broker spread, execution and account risk are not verified. The application never executes trades or modifies broker-side orders.

## What is implemented

- React + Vite + MUI dashboard, responsive navigation and Lightweight Charts candlesticks with reference OHLC bars, crosshair OHLC, timeframe selector, confirmed structure markers, rule IDs, support/resistance bounds, liquidity references and supply/demand zones.
- Public XAUS chart-API adapter for M5, M15, M30, H1, H4 and D1 OHLC bars. The adapter validates prices and timestamps, excludes forming bars, marks spot volume unavailable, and caches each timeframe for 60 seconds. The feed is an indicative Yahoo Finance proxy, not a broker quote; reference mode does not issue trade entries.
- Node.js + Express API with password hashing, signed HTTP-only session cookie, per-user settings/trades/journal/alerts, rate limiting, Helmet, CORS origin restriction, audit records and server-side input validation.
- MongoDB collections and compound indexes for candles, snapshots, settings, users, analysis, zones, patterns, setups, trades, alerts, deliveries, news, backtests, journal and audit records. Candle data is upserted by provider/symbol/timeframe/UTC timestamp. Snapshots retain only the latest tick. TTL retention defaults to 5 years for candles, 3 years for alerts/deliveries and 7 years for audit logs; set a retention day count to `0` to disable that TTL index.
- Python analysis service: confirmed swing highs/lows (3 left + 3 right closed bars), HH/HL/LH/LL, candle-close BOS/CHoCH, separate provisional wick penetrations, simple trend/range context, true-range volatility expansion/contraction, pivot-cluster support/resistance, candidate supply/demand zones after a defined displacement, previous day/week/month OHLC, equal-pivot and session liquidity references, potential wick-and-close liquidity sweeps, and double-top/bottom candidates. Findings include rule IDs, confirmation times or invalidation text. Fewer than 20 candles returns “Insufficient data.” Session defaults use Singapore, London, and New York IANA time zones with daylight-saving support.
- Reproducible breakout and retest backtests on stored provider candles. Signals use completed bars, entries use the following bar open, the last chronological data slice is reserved for out-of-sample scoring, same-candle stop/target ambiguity resolves conservatively, and user-supplied spread/slippage/commission assumptions are applied. Results include sample sizes, R metrics, drawdown, session/regime breakdowns and target sensitivity. Runs and test trades are saved per user. Synthetic data is rejected.
- Optional U.S. high-impact economic calendar import from the [Trading Economics calendar API](https://docs.tradingeconomics.com/economic_calendar/snapshot/). It preserves provider actual/forecast/previous values and UTC event times, shows estimated-time status, and can create reminders or an opt-in exact-time news window that changes the app plan to `NO_TRADE`. This filter does not forecast XAUUSD's reaction.
- Conditional plan states, including an explicit stale-data gate; manual trade registration and tick-based SL/TP approach/reach alerts; cooldown/deduplication; tighter-only tracking stop updates; manual outcome records; risk-limit checks on new app records; and an optional size estimate only when live MT5 tick/volume/account-currency metadata and matching manually entered equity are present.
- Website alert records/WebSocket updates and an optional Telegram worker with quiet hours, delivery records and at most three retries. Telegram bot token is server-only. Optional OpenAI Responses API explanation uses the [official Structured Outputs JSON Schema format](https://developers.openai.com/api/docs/guides/structured-outputs) and server validation; it cannot alter the deterministic plan.
- Reproducible local synthetic candles in development. They are fixed-coordinate test data marked illustrative; price cards stay blank, explanations say they are not market data, and the plan state is `DATA_UNAVAILABLE`.
- Docker Compose for MongoDB, API, Python analysis service and static web client. The web container is intended to sit behind a TLS-terminating reverse proxy or cloud HTTPS ingress.

## FundingPips / MT5 integration status

The development machine inspected for this project has no installed MT5 terminal and no Python command on its system PATH. No FundingPips account was available to sign in, so this implementation does **not** claim that the user's assigned account, exact symbol alias, server or feed was verified.

FundingPips' [MT5 connection guide](https://help.fundingpips.com/hc/en-us/articles/43468639481105-Account-Workspace) lists `FundingPips-SIM1` and `FundingPips2-SIM` along with the corresponding broker entries. The server assigned to an account must be checked in the FundingPips dashboard. FundingPips says Investor credentials are view-only. MetaQuotes' [official Python integration documentation](https://www.mql5.com/en/docs/python_metatrader5) describes the Python package as inter-process access to a local MT5 terminal, and its [`initialize()` reference](https://www.mql5.com/en/docs/python_metatrader5/mt5initialize_py) can find or launch a terminal. PyPI currently publishes the official package wheel for CPython 3.12 on 64-bit Windows ([release files](https://pypi.org/project/metatrader5/)). This supports the proposed Windows VPS route in principle; only the read-only compatibility check on the actual VPS can establish account access.

The collector never accepts a password, never calls `order_send`, and never sends an order. Sign in to the MT5 desktop terminal on the VPS using the assigned server; prefer view-only credentials for data access. `--check` verifies the connected server, exact configured symbol, readable ticks and a closed M15 candle without sending data to the cloud. If XAUUSD is named differently, the check reports candidate names and stops so you can explicitly configure the correct symbol.

## Local development

Requirements: Node.js 22+, Python 3.12+, and MongoDB 7+ (local or Docker). In a terminal at the repository root:

1. Copy `.env.example` to `.env` and set a long random `JWT_SECRET`. `DATA_MODE=illustrative` is the development default; set `DATA_MODE=xaus` to use the public reference-feed analysis view.
2. Start MongoDB (for example `docker compose up -d mongo`).
3. Install the analysis service's IANA timezone database: `py -3 -m pip install -r services/analysis/requirements.txt` on Windows, or `python3 -m pip install -r services/analysis/requirements.txt` elsewhere.
4. Run `npm install` once.
5. Run `npm run dev`; the root script starts the API, Python analysis service and web client together.
6. Open `http://localhost:5173`; create an account using a 12+ character password.

The backend listens on port 4000, analysis on 8001, and Vite on 5173. The Vite proxy keeps API and WebSocket requests same-origin. The API reads the repository-root `.env`. The Python launcher tries `py -3` then `python` on Windows, or `python3` then `python` elsewhere; set `PYTHON` to an explicit executable path if needed.

## Read-only Windows VPS collector

1. Deploy the cloud services behind HTTPS and initially set `DATA_MODE=disabled`, `MARKET_SYMBOL` to the exact broker symbol, and `COLLECTOR_TOKEN` to a unique random value of at least 32 characters. Set a different long random `JWT_SECRET`.
2. On the Windows VPS, install MT5 and sign in to the account's assigned FundingPips server. Check the server in FundingPips Credentials first; do not guess from the public server list.
3. Install Python 3.12+ and run `py -m pip install -r collector/requirements.txt`.
4. Copy `collector/.env.example` to a private collector `.env`, then set the HTTPS API URL, the same collector token, exact MT5 symbol, and `MT5_EXPECTED_SERVER` to the exact server shown in FundingPips Credentials. The collector reads this adjacent `.env` file and refuses to start if the expected server is blank or does not match. Do not add account passwords or bot tokens.
5. Run `py collector/mt5_collector.py --check`. Confirm the output reports the intended account server, readable XAUUSD tick, and a closed M15 candle. It does not transmit data. If it fails, do not enable provider mode.
6. After the check succeeds, run `py collector/mt5_collector.py` as a Windows service or supervised scheduled task. Confirm the API accepts a collector upload; then set `DATA_MODE=provider` on the cloud API and restart it. Restrict the VPS and environment file, use a view-only MT5 login where supported, and allow outbound HTTPS to the API.

MT5 terminal, collector, cloud API, database and analysis service must stay running for continuous monitoring. Your personal computer can be off. If the terminal or feed disconnects, the API hides the old price and creates a persisted data-status alert; it does not claim to be live. The first successful collector upload changes no app mode automatically; switch to `DATA_MODE=provider` deliberately only after confirming ingestion.

## Authentication and configuration

- Production account creation is disabled unless `ALLOW_REGISTRATION=true`. Temporarily enable it for the initial account, create the user, then disable it and restart. No email-based password recovery is included in this release.
- Public production traffic must be HTTPS. The Compose web server listens on port 8080 and is not itself TLS; put it behind your HTTPS ingress/reverse proxy. Do not expose MongoDB publicly. For a managed cloud MongoDB, supply its TLS-enabled connection URI through `MONGO_URI`.
- `COLLECTOR_TOKEN` authenticates data uploads. Do not reuse `JWT_SECRET` or any account credential.
- `TELEGRAM_BOT_TOKEN` is a server environment secret; enter the chat ID in Settings. Tokens are never returned to the browser or logged.
- `OPENAI_API_KEY` and `OPENAI_MODEL` are optional server settings. AI explanation is unavailable until configured. The Responses API uses strict structured output and the dashboard keeps rule-generated facts separate.
- `TRADING_ECONOMICS_API_KEY` is optional and must stay server-side. Configure it to import high-impact U.S. calendar events; without it, the calendar shows an explicit unavailable state. The application stores the provider's event values and does not infer consensus or actuals.
- The account equity and currency in Settings are manually entered. The API only computes risk when collector metadata reports matching account currency plus MT5 tick and volume specs.

## Deployment

For the Netlify frontend setup and the access needed to deploy the full stack, see [NETLIFY_DEPLOY.md](NETLIFY_DEPLOY.md).

1. Provision an HTTPS reverse proxy/domain and a private MongoDB service with backups.
2. Copy `.env.example` to the deployment host's secret store; set `JWT_SECRET`, `WEB_ORIGIN`, `NODE_ENV=production`, and `DATA_MODE=xaus` for public reference analysis. Use `DATA_MODE=disabled` to hide market analysis or `DATA_MODE=provider` only after a verified broker collector is connected; provider mode also needs a unique `COLLECTOR_TOKEN`. Compose uses its private MongoDB container by default; for managed MongoDB, set `COMPOSE_MONGO_URI` to its TLS-enabled URI. `MONGO_URI` is used by local Node development. Never commit a real `.env`.
3. Enable registration for first-time account creation, start Compose with `docker compose up --build -d`, create the account through HTTPS, then disable registration and restart the API.
4. Complete the VPS `--check` and a collector upload. Then set `DATA_MODE=provider`, restart the API, and confirm `/api/health`, Dashboard connection status, latest update time and chart timestamp before relying on analysis.
5. Back up MongoDB regularly and test restore into a separate database. Mongo backups should include user/trade/settings data and retained candles; VPS backups should not expose the MT5 terminal's stored credentials.

The included Compose stack provides process health checks and restart policies; it does not provision a domain, TLS certificate, managed database, cloud secrets, monitoring vendor or Windows VPS. Continuous cloud operation depends on those external services staying healthy.

## Verification

- API unit tests: `node --test apps/api/src/rules.test.js`
- Python analysis tests: `python -m unittest discover -s services/analysis/tests -v`
- Frontend type/lint check: `npm run lint --workspace apps/web`
- Frontend production build: `npm run build --workspace apps/web`

The test suite verifies rule functions, validation and no-actionable-plan gates. It does not verify a live broker connection, a Telegram bot/chat, OpenAI key access, production HTTPS or a cloud deployment.

## Deliberate limitations

- The account and broker connection is unverified here. Do not switch to provider mode until the Windows VPS check succeeds.
- Economic calendar import requires a valid `TRADING_ECONOMICS_API_KEY`; this environment has no provider key, so a live provider sync was not verified. The calendar integration does not include historical news-reaction backtests, DXY, or Treasury-yield feeds.
- The backtester contains two simple documented research rules; it does not establish profitability, test every rule combination, model broker swaps/commission schedules automatically, or simulate a full portfolio. Configure price-unit costs from a verified broker source and treat small samples cautiously.
- Automatic MT5 position import, news-reaction backtests, a broad advanced pattern set (head-and-shoulders, triangles, flags/channels), a separate MSS classifier, configurable session boundaries in the UI, break-even/trailing-stop proposal policies, and AI-based signal generation are not included.
- Market structure and pivot zones are hypotheses governed by documented deterministic rules. They do not predict guaranteed outcomes. There are no live recommendations from illustrative candles.
- Risk amount uses verified tick value/size and the configured account currency/equity; external/manual P&L and unregistered trades are not included in limits.
- Registration, session cookie auth and per-user scoping are included; password recovery, email verification and a hardened organization-wide identity provider are not included.
