// Trades Dashboard backend.
//
//   GET  /                 dashboard UI (static)
//   GET  /api/state        stats + active pull + recent pulls (served from local store -> instant)
//   GET  /api/trades       all trades, or ?afterSeq=N for only the ones ingested after seq N
//   POST /api/pulls        ask BSE for a new pull (returns immediately with the pull record)
//   GET  /api/pulls        pull history
//   GET  /api/events       Server-Sent Events stream (push updates to the browser)
//   POST /webhooks/bse     signed "trades.ready" callback from BSE

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeStore } from './store.js';
import { EventHub } from './events.js';
import { PullService } from './pullService.js';
import { loadEnv, num, json, readBody, log, isMain } from '../shared/config.js';
import { verify } from '../shared/signature.js';

const SERVICE = 'dashboard';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export async function startDashboard(options = {}) {
  loadEnv();
  const env = process.env;
  const cfg = {
    port: num(options.port ?? env.DASHBOARD_PORT, 3000),
    host: options.host ?? env.DASHBOARD_HOST ?? '0.0.0.0',
    bseBaseUrl: options.bseBaseUrl ?? env.BSE_BASE_URL ?? 'http://127.0.0.1:4000',
    publicUrl: options.publicUrl ?? env.DASHBOARD_PUBLIC_URL ?? '',
    dataFile: options.dataFile !== undefined ? options.dataFile : path.resolve(env.DATA_FILE ?? './data/store.json'),
    webhookSecret: options.webhookSecret ?? env.WEBHOOK_SECRET ?? 'change-me-in-prod',
    sseMaxConnMs: num(options.sseMaxConnMs ?? env.SSE_MAX_CONN_MS, 25000),
    sseHeartbeatMs: num(options.sseHeartbeatMs ?? env.SSE_HEARTBEAT_MS, 10000),
    fetchTimeoutMs: num(options.fetchTimeoutMs ?? env.BSE_FETCH_TIMEOUT_MS, 20000),
    quiet: options.quiet ?? false,
  };
  const say = (...a) => !cfg.quiet && log(SERVICE, ...a);

  const store = new TradeStore(cfg.dataFile);
  await store.load();

  let pulls = null; // created right below; referenced lazily by helloState
  const hub = new EventHub({
    maxConnMs: cfg.sseMaxConnMs,
    heartbeatMs: cfg.sseHeartbeatMs,
    helloState: () => ({ lastSeq: store.seq, activePull: pulls?.active() ?? null }),
  });
  pulls = new PullService({
    store,
    hub,
    bseBaseUrl: cfg.bseBaseUrl,
    publicUrl: cfg.publicUrl, // finalised after listen() if not configured
    fetchTimeoutMs: cfg.fetchTimeoutMs,
    say,
  });

  const state = () => ({
    lastSeq: store.seq,
    stats: store.stats(),
    activePull: pulls.active(),
    recentPulls: store.pulls.slice(0, 10),
    serverTime: new Date().toISOString(),
  });

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, service: SERVICE });
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && pathname === '/api/trades') {
      const afterSeq = Math.max(0, num(url.searchParams.get('afterSeq'), 0));
      return json(res, 200, { lastSeq: store.seq, trades: store.since(afterSeq) });
    }
    if (req.method === 'GET' && pathname === '/api/pulls') return json(res, 200, { pulls: store.pulls });
    if (req.method === 'POST' && pathname === '/api/pulls') {
      const { conflict, pull } = await pulls.startPull();
      return json(res, conflict ? 409 : pull.status === 'FAILED' ? 502 : 202, {
        pull,
        ...(conflict ? { error: 'A pull is already in progress' } : {}),
      });
    }
    if (req.method === 'GET' && pathname === '/api/events') return hub.attach(req, res);

    if (req.method === 'POST' && pathname === '/webhooks/bse') {
      const raw = await readBody(req);
      if (!verify(cfg.webhookSecret, raw, req.headers['x-bse-signature'])) {
        say('rejected webhook with bad signature');
        return json(res, 401, { error: 'Invalid signature' });
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      // Acknowledge immediately; do the (multi-request) ingest after the response is sent.
      json(res, 202, { accepted: true });
      setImmediate(() => pulls.handleWebhook(payload).catch((e) => say('webhook handling error', e)));
      return;
    }

    if (req.method === 'GET') return serveStatic(pathname, res);
    return json(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      say('request error', err);
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message ?? 'Internal error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const selfUrl = `http://127.0.0.1:${server.address().port}`;
  if (!cfg.publicUrl) cfg.publicUrl = selfUrl;
  pulls.publicUrl = cfg.publicUrl;

  say(`listening on ${selfUrl} — ${store.seq} trades loaded from ${cfg.dataFile ?? '(memory)'}`);
  say(`BSE at ${cfg.bseBaseUrl}; webhook callback ${cfg.publicUrl}/webhooks/bse`);
  pulls.reconcile().catch((e) => say('reconcile error', e));

  return {
    server,
    store,
    hub,
    pulls,
    url: () => selfUrl,
    close: () =>
      new Promise((resolve) => {
        hub.closeAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (isMain(import.meta.url)) {
  const app = await startDashboard();
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
