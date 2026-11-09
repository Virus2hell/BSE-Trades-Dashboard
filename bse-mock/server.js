import http from 'node:http';
import crypto from 'node:crypto';
import { createTradeGenerator } from './tradeGenerator.js';
import { loadEnv, num, json, log, isMain } from '../shared/config.js';
import { sign } from '../shared/signature.js';

const SERVICE = 'bse-mock';
const MAX_PAGE_SIZE = 1000;
const WEBHOOK_RETRY_DELAYS_MS = [1000, 5000, 15000, 60000, 300000]; // bounded delivery retries

export function startBseMock(options = {}) {
  loadEnv();
  const env = process.env;
  const cfg = {
    port: num(options.port ?? env.BSE_PORT, 4000),
    host: options.host ?? env.BSE_HOST ?? '0.0.0.0',
    publicUrl: options.publicUrl ?? env.BSE_PUBLIC_URL ?? '',
    pullDelayMs: num(options.pullDelayMs ?? env.PULL_DELAY_MS, 15 * 60 * 1000),
    baseTrades: num(options.baseTrades ?? env.BASE_TRADES, 3000),
    newTradesMin: num(options.newTradesMin ?? env.NEW_TRADES_MIN, 40),
    newTradesMax: num(options.newTradesMax ?? env.NEW_TRADES_MAX, 150),
    seed: num(options.seed ?? env.SEED, 42),
    maxConnMs: num(options.maxConnMs ?? env.NETWORK_MAX_CONN_MS, 30000),
    webhookSecret: options.webhookSecret ?? env.WEBHOOK_SECRET ?? 'change-me-in-prod',
    allowDelayOverride: (options.allowDelayOverride ?? env.ALLOW_DELAY_OVERRIDE ?? 'true') !== 'false',
    resultTtlMs: num(options.resultTtlMs ?? env.RESULT_TTL_MS, 60 * 60 * 1000),
    quiet: options.quiet ?? false,
  };
  const say = (...a) => !cfg.quiet && log(SERVICE, ...a);

  const market = createTradeGenerator({ seed: cfg.seed, baseCount: cfg.baseTrades });
  const jobs = new Map(); // jobId -> job
  const timers = new Set();

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  const baseUrl = () => cfg.publicUrl || `http://127.0.0.1:${server.address().port}`;

  function jobView(job) {
    return {
      jobId: job.jobId,
      status: job.status,
      requestedAt: job.requestedAt,
      estimatedReadyAt: job.estimatedReadyAt,
      readyAt: job.readyAt ?? null,
      totalRecords: job.trades ? job.trades.length : null,
      pageSize: MAX_PAGE_SIZE,
      totalPages: job.trades ? Math.max(1, Math.ceil(job.trades.length / MAX_PAGE_SIZE)) : null,
      statusUrl: `${baseUrl()}/getTrades/jobs/${job.jobId}`,
      resultsUrl: `${baseUrl()}/getTrades/jobs/${job.jobId}/results`,
      callbackUrl: job.callbackUrl ?? null,
      webhook: job.webhook,
    };
  }

  function completeJob(job) {
    // New trades "happened" on the exchange while the pull was running.
    const fresh = market.randInt(cfg.newTradesMin, cfg.newTradesMax);
    market.append(fresh);
    job.trades = market.all().slice(); // immutable snapshot for this job
    job.status = 'READY';
    job.readyAt = new Date().toISOString();
    say(`job ${job.jobId} READY (${job.trades.length} trades, ${fresh} new since last pull)`);
    later(() => {
      jobs.delete(job.jobId);
    }, cfg.resultTtlMs);
    if (job.callbackUrl) deliverWebhook(job, 0);
  }

  async function deliverWebhook(job, attempt) {
    const v = jobView(job);
    const body = JSON.stringify({
      event: 'trades.ready',
      jobId: job.jobId,
      status: job.status,
      readyAt: job.readyAt,
      totalRecords: v.totalRecords,
      pageSize: v.pageSize,
      totalPages: v.totalPages,
      resultsUrl: v.resultsUrl,
    });
    job.webhook.attempts = attempt + 1;
    try {
      const res = await fetch(job.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BSE-Event': 'trades.ready',
          'X-BSE-Signature': sign(cfg.webhookSecret, body),
          'X-BSE-Delivery': crypto.randomUUID(),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      job.webhook.delivered = true;
      job.webhook.lastError = null;
      say(`job ${job.jobId} webhook delivered -> ${job.callbackUrl}`);
    } catch (err) {
      job.webhook.lastError = String(err.message || err);
      const delay = WEBHOOK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !jobs.has(job.jobId)) {
        say(`job ${job.jobId} webhook FAILED permanently: ${job.webhook.lastError}`);
        return;
      }
      say(`job ${job.jobId} webhook failed (${job.webhook.lastError}); retry in ${delay} ms`);
      later(() => deliverWebhook(job, attempt + 1), delay);
    }
  }

  function startJob(url, res) {
    const callbackUrl = url.searchParams.get('callbackUrl');
    if (callbackUrl) {
      try {
        const u = new URL(callbackUrl);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch {
        return json(res, 400, { error: 'callbackUrl must be an absolute http(s) URL' });
      }
    }
    let delay = cfg.pullDelayMs;
    const override = url.searchParams.get('delayMs');
    if (override !== null && cfg.allowDelayOverride) delay = Math.max(0, num(override, delay));

    const now = Date.now();
    const job = {
      jobId: crypto.randomUUID(),
      status: 'PENDING',
      requestedAt: new Date(now).toISOString(),
      estimatedReadyAt: new Date(now + delay).toISOString(),
      callbackUrl: callbackUrl || null,
      webhook: { delivered: false, attempts: 0, lastError: null },
      trades: null,
    };
    jobs.set(job.jobId, job);
    later(() => completeJob(job), delay);
    say(`job ${job.jobId} accepted; ready in ${Math.round(delay / 1000)} s`);
    const view = jobView(job);
    return json(res, 202, view, { Location: view.statusUrl, 'Retry-After': String(Math.ceil(delay / 1000)) });
  }

  function results(job, url, res) {
    if (job.status !== 'READY') {
      return json(res, 409, { error: 'Job not ready yet', status: job.status, estimatedReadyAt: job.estimatedReadyAt });
    }
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, num(url.searchParams.get('pageSize'), MAX_PAGE_SIZE)));
    const page = Math.max(1, Math.floor(num(url.searchParams.get('page'), 1)));
    const totalRecords = job.trades.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
    const trades = job.trades.slice((page - 1) * pageSize, page * pageSize);
    return json(res, 200, { jobId: job.jobId, page, pageSize, totalPages, totalRecords, trades });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: SERVICE, pullDelayMs: cfg.pullDelayMs, jobs: jobs.size });
    }
    if (url.pathname === '/getTrades') return startJob(url, res);

    if (parts[0] === 'getTrades' && parts[1] === 'jobs' && parts[2]) {
      const job = jobs.get(parts[2]);
      if (!job) return json(res, 404, { error: 'Unknown or expired job' });
      if (parts.length === 3) return json(res, 200, jobView(job));
      if (parts.length === 4 && parts[3] === 'results') return results(job, url, res);
    }
    return json(res, 404, { error: 'Not found' });
  });

  // Simulate the corporate network: any TCP connection older than maxConnMs is cut.
  server.on('connection', (socket) => {
    if (!cfg.maxConnMs) return;
    const t = setTimeout(() => socket.destroy(), cfg.maxConnMs);
    t.unref();
    socket.on('close', () => clearTimeout(t));
  });
  server.keepAliveTimeout = 5000;

  const ready = new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      say(`listening on ${baseUrl()} (pull delay ${cfg.pullDelayMs} ms, ${cfg.baseTrades} seeded trades)`);
      resolve();
    });
  });

  return {
    server,
    ready,
    url: () => baseUrl(),
    close: () =>
      new Promise((resolve) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (isMain(import.meta.url)) {
  const app = startBseMock();
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
