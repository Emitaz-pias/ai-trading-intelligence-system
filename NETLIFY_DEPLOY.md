# Netlify deployment

Netlify will host the React/Vite frontend. The repository's Express API, Python analysis service, MongoDB, and WebSocket server need a separate always-on backend host; Netlify publishes the files in the configured publish directory and does not run this app's server or database.

## Frontend build

The root `netlify.toml` is already configured for this monorepo:

- Build command: `npm run build`
- Publish directory: `apps/web/dist`
- SPA routes: rewritten to `index.html`
- Node.js build version: 22

## Backend and domain

For the existing production session cookie and WebSocket to work in browsers, use two HTTPS subdomains under the same domain, for example:

- Frontend: `https://app.example.com` on Netlify
- Backend: `https://api.example.com` on a Docker-capable host with persistent storage
- WebSocket: `wss://api.example.com/ws`

The API currently uses a secure, `SameSite=Lax` cookie. A shared parent domain keeps the frontend and API same-site. Configure the API's `WEB_ORIGIN` to the exact frontend origin, such as `https://app.example.com`.

After the API has a public HTTPS address, set these Netlify build environment variables and redeploy:

- `VITE_API_BASE_URL=https://api.example.com`
- `VITE_WS_URL=wss://api.example.com/ws`

Those `VITE_` values are public browser configuration. Do not put passwords, JWT secrets, database URIs, provider keys, or collector tokens in Netlify's frontend environment.

The backend needs `JWT_SECRET`, `MONGO_URI` (or the included Compose MongoDB with persistent storage), `WEB_ORIGIN`, and `DATA_MODE=disabled` for the initial deployment. Keep backend secrets in the backend host's secret/environment settings. The project has no Git remote or commits yet, so automatic Netlify deployments also require a private GitHub repository and permission to push this code.

## Access needed from the owner

1. Sign in to Netlify in the browser and authorize its GitHub integration.
2. Sign in to GitHub and create or select a **private** repository for this project.
3. Provide access to a backend host account that can run Docker services continuously and keep database storage persistent. If using managed MongoDB instead, provide access to that database account as well.
4. Provide a domain you own and DNS editing access for the `app` and `api` subdomains, or say if you do not have a domain yet.

Do not send passwords, one-time codes, API keys, or cloud tokens in chat. Sign in yourself and enter any provider secrets directly in that provider's dashboard. No OpenAI, Telegram, or economic-calendar key is required for the initial deployment.

## Live MT5 feed

The initial deployment must remain in `DATA_MODE=disabled`, so it will not show a live XAUUSD price. A live feed needs a Windows VPS with MT5 signed in to the assigned FundingPips server and the project's read-only collector running there. The owner can sign in to MT5 on that VPS; never send MT5 passwords in chat. Enable provider mode only after the collector's local `--check` succeeds and the API confirms ingestion.
