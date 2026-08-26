# HyperTrade AI Agents Showcase

Read-only public demo of house-funded AI agents.

- Equity chart: Hyperliquid `portfolio` **pnlHistory** as `$startingCapital + PnL` (most house agents $1k; Phase 0 10k book is mapped in the UI)
- Positions / decisions from Supabase; open orders from HL (symbol-filtered)
- Refreshes every 30s (API cached ~28s)

## Run

```bash
# Backend (Railway or local) must expose GET /api/showcase/agents
# SHOWCASE_AGENT_IDS=uuid,uuid  (empty/unset = no agents listed)

cd showcase
npm install
npm run dev
```

Vite proxies `/api` → `http://127.0.0.1:8000` (override with `VITE_PROXY_TARGET`).
Or set `VITE_API_BASE=https://your-backend` for a remote API.

## Deploy

`npm run build` → static `dist/`. Point `VITE_API_BASE` at production backend at build time
(e.g. `https://api.hypertrade.exchange`). Redeploy Vercel after changing that env — Vite
bakes it into the bundle at build time.

Production host: `https://ai.hypertrade.exchange` (CORS allowlisted on the API).
