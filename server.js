// uptime-mini — a tiny self-hosted uptime monitor, zero dependencies.
// Node >= 20. Storage: a single JSON file in DATA_DIR.
// Env: PORT (default 3000), DATA_DIR (default ./data),
//      ADMIN_PASSWORD (optional; when set, dashboard + API need login),
//      TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional; status-change alerts).

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'monitors.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CHECK_TIMEOUT_MS = 10_000;
const HISTORY_CAP = 200;

// ---------------------------------------------------------------- store ---

function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.monitors)) return data;
  } catch { /* missing or corrupt: start fresh */ }
  return { monitors: [] };
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const store = loadStore();
const timers = new Map(); // monitor id -> setInterval handle

// ------------------------------------------------------------- checking ---

function uptime24h(monitor) {
  const since = Date.now() - 24 * 3600 * 1000;
  const recent = monitor.history.filter((h) => h.t >= since);
  if (recent.length === 0) return null;
  const ok = recent.filter((h) => h.ok).length;
  return Math.round((ok / recent.length) * 1000) / 10;
}

function publicMonitor(monitor) {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    intervalSeconds: monitor.intervalSeconds,
    status: monitor.status, // 'up' | 'down' | 'pending'
    lastCheck: monitor.lastCheck,
    lastLatencyMs: monitor.lastLatencyMs,
    uptime24h: uptime24h(monitor),
    history: monitor.history.slice(-30),
  };
}

async function checkOnce(monitor) {
  const started = Date.now();
  let ok = false;
  let ms = null;
  try {
    const res = await fetch(monitor.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { 'user-agent': 'uptime-mini/0.1' },
    });
    ok = res.status < 400;
    ms = Date.now() - started;
    // Drain the body so the connection can close cleanly.
    await res.arrayBuffer().catch(() => {});
  } catch {
    ok = false;
    ms = Date.now() - started;
  }

  const prev = monitor.status;
  monitor.status = ok ? 'up' : 'down';
  monitor.lastCheck = Date.now();
  monitor.lastLatencyMs = ms;
  monitor.history.push({ t: monitor.lastCheck, ok, ms });
  if (monitor.history.length > HISTORY_CAP) {
    monitor.history.splice(0, monitor.history.length - HISTORY_CAP);
  }
  saveStore();

  if (prev !== 'pending' && prev !== monitor.status) {
    notifyStatusChange(monitor, ok);
  }
}

function schedule(monitor) {
  unschedule(monitor.id);
  timers.set(
    monitor.id,
    setInterval(() => void checkOnce(monitor), monitor.intervalSeconds * 1000),
  );
  void checkOnce(monitor);
}

function unschedule(id) {
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
}

// ------------------------------------------------------------ telegram ---

function telegramSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text });
  const req = https.request(
    `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    },
    (res) => res.resume(),
  );
  req.on('error', (err) => console.error('[telegram]', err.message));
  req.end(body);
}

function notifyStatusChange(monitor, isUp) {
  const icon = isUp ? '🟢' : '🔴';
  const word = isUp ? 'RECOVERED' : 'DOWN';
  const extra = isUp ? ` — ${monitor.lastLatencyMs}ms` : '';
  telegramSend(
    `${icon} ${word}: ${monitor.name}\n${monitor.url}${extra}`,
  );
}

// ---------------------------------------------------------------- auth ---

const SESSION_COOKIE = 'uptime-mini-session';

function sessionValue(password) {
  return crypto
    .createHmac('sha256', password)
    .update('uptime-mini-session')
    .digest('hex');
}

function isAuthed(req) {
  if (!ADMIN_PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9]{64})`));
  if (!match) return false;
  const expected = Buffer.from(sessionValue(ADMIN_PASSWORD));
  const actual = Buffer.from(match[1]);
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

// -------------------------------------------------------------- helpers ---

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- routes ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname === '/health') {
      return json(res, 200, { status: 'ok' });
    }

    if (pathname === '/api/me') {
      return json(res, 200, {
        authRequired: Boolean(ADMIN_PASSWORD),
        authed: isAuthed(req),
      });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse((await readBody(req)) || '{}');
      if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
        res.writeHead(200, {
          'set-cookie': `${SESSION_COOKIE}=${sessionValue(ADMIN_PASSWORD)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
          'content-type': 'application/json',
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 401, { error: 'wrong password' });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        'content-type': 'application/json',
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (pathname === '/api/monitors') {
      if (!isAuthed(req)) return json(res, 401, { error: 'login required' });

      if (req.method === 'GET') {
        return json(res, 200, {
          monitors: store.monitors.map(publicMonitor),
        });
      }

      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        const target = String(body.url || '').trim();
        const interval = Math.min(
          3600,
          Math.max(10, Number(body.intervalSeconds) || 60),
        );
        if (!name) return json(res, 400, { error: 'name is required' });
        if (!validUrl(target)) {
          return json(res, 400, { error: 'url must be http(s)' });
        }
        const monitor = {
          id: crypto.randomUUID(),
          name,
          url: target,
          intervalSeconds: interval,
          status: 'pending',
          lastCheck: null,
          lastLatencyMs: null,
          history: [],
        };
        store.monitors.push(monitor);
        saveStore();
        schedule(monitor);
        return json(res, 201, { monitor: publicMonitor(monitor) });
      }

      return json(res, 405, { error: 'method not allowed' });
    }

    const deleteMatch = pathname.match(/^\/api\/monitors\/([A-Za-z0-9-]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      if (!isAuthed(req)) return json(res, 401, { error: 'login required' });
      const idx = store.monitors.findIndex((m) => m.id === deleteMatch[1]);
      if (idx === -1) return json(res, 404, { error: 'not found' });
      unschedule(store.monitors[idx].id);
      store.monitors.splice(idx, 1);
      saveStore();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/' || pathname === '/index.html') {
      const file = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': file.length,
      });
      return res.end(file);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'internal error' });
  }
});

// ---------------------------------------------------------------- start ---

for (const monitor of store.monitors) schedule(monitor);

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[uptime-mini] listening on :${PORT}, data dir ${DATA_DIR}, ` +
      `${store.monitors.length} monitor(s), ` +
      `auth ${ADMIN_PASSWORD ? 'on' : 'off'}, ` +
      `telegram ${TG_TOKEN && TG_CHAT_ID ? 'on' : 'off'}`,
  );
});
