# Hosted deployment

## Frontend

The Netlify project `piastradinganalysis` is connected to this repository's `main` branch. Its public URL is `https://piastradinganalysis.netlify.app`. The repository root `netlify.toml` sets the build command to `npm run build`, publishes `apps/web/dist`, and rewrites client-side routes to `index.html`.

The frontend is a static site. Netlify does not run the Express API, the Python analysis service, or MongoDB.

## API and analysis service

`render.yaml` and `Dockerfile.render` define one Render Docker web service for the Node API and Python analysis service. It starts in `DATA_MODE=xaus` and reads free public XAU/USD reference OHLC bars; the chart draws rule-based structure and zones from those bars. This source is an indicative Yahoo Finance proxy, not OANDA/FundingPips, so the trade plan stays `NO_TRADE`. A verified broker collector is still required for broker-specific trade conditions. Render should receive a MongoDB Atlas connection URI through the `MONGO_URI` secret setting. Never commit that URI or send it in chat.

After Render creates the service and assigns its public `onrender.com` hostname, add a Netlify proxy rule for `/api/*` above the SPA fallback in `netlify.toml`. This lets the browser use the Netlify origin for API requests and the HTTP-only session cookie.

Netlify's proxy rewrites are HTTP-only and do not proxy WebSocket connections. With the requested default `netlify.app` domain, the app can use the API's HTTP endpoints and periodic refresh, but cannot receive WebSocket push updates through the Netlify proxy. A custom domain with a shared parent domain is needed for the current WebSocket authentication flow.

## Free-tier limits

Render Free web services sleep after 15 minutes without inbound requests and take about a minute to wake. Their local files are ephemeral and Free services cannot attach persistent disks. MongoDB Atlas Free clusters provide 0.5 GB storage and can be paused after 30 days without connections. This setup is suitable for a low-traffic preview, not reliable always-on trading monitoring. A paid always-on Render service and persistent database plan would add cost and must be chosen by the owner.

## Owner steps

1. Sign in to MongoDB Atlas (or create an Atlas account), create a Free cluster, create a database user, and allow the Render service to connect. Enter the resulting `MONGO_URI` directly into the Render service's Environment settings. Do not share the password or URI in chat.
2. Once the API health endpoint reports the database and analysis service as healthy, temporarily enable `ALLOW_REGISTRATION` in Render, create your account at the site, then disable registration again.
3. The public chart and reference analysis need no MT5 login or API key. Keep the service in `DATA_MODE=xaus` for that view. To switch to FundingPips-specific analysis later, a Windows VPS with an active MT5 account must pass the collector's read-only `--check` and upload fresh candles before you set `DATA_MODE=provider`.

No OpenAI, Telegram, or economic-calendar key is needed for the initial deployment.
