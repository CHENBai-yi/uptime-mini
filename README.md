# uptime-mini

A tiny self-hosted uptime monitor, written by hand. Zero npm dependencies —
only Node.js built-ins. Add an HTTP(S) URL, it checks it on a schedule and
shows UP/DOWN, latency, and 24h uptime on a dashboard. Status changes can
push a Telegram alert.

## Run

```bash
node server.js
```

No `npm install` needed. Requires Node >= 20.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `./data` | Where `monitors.json` lives (put it somewhere that survives restarts) |
| `ADMIN_PASSWORD` | _(empty = no login)_ | When set, the dashboard and API need this password |
| `TELEGRAM_BOT_TOKEN` | _(empty = off)_ | Bot token for status-change alerts |
| `TELEGRAM_CHAT_ID` | _(empty = off)_ | Chat to send alerts to |

## Endpoints

- `GET /` — dashboard (add / delete monitors, live status)
- `GET /health` — `{"status":"ok"}`, always public, for platform health checks
- `GET /api/monitors` — list monitors
- `POST /api/monitors` — `{name, url, intervalSeconds}` (interval 10–3600s)
- `DELETE /api/monitors/:id`
- `POST /api/login`, `POST /api/logout` — session login when `ADMIN_PASSWORD` is set

## Deploy notes (UppCoder Blank stack, Node.js)

- Start command: `node server.js`
- Set `PORT` to the stack's app-port and `DATA_DIR` to `/home/uppcoder/uptime-mini-data`
  so monitors survive restarts (that directory is backed up nightly).
- Set `ADMIN_PASSWORD` and the two `TELEGRAM_*` variables in the stack's
  environment settings. Never commit secrets to the repo.
