// End-to-end: real mock BSE + real dashboard on random ports, with a 1.5 s "full pull".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startBseMock } from '../bse-mock/server.js';
import { startDashboard } from '../dashboard/server.js';
import { sign } from '../shared/signature.js';

const SECRET = 'test-secret';
let bse;
let dash;
let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trades-'));
  bse = startBseMock({ port: 0, host: '127.0.0.1', pullDelayMs: 1500, baseTrades: 2500, maxConnMs: 30000, webhookSecret: SECRET, quiet: true });
  await bse.ready;
  dash = await startDashboard({
    port: 0, host: '127.0.0.1', bseBaseUrl: bse.url(), dataFile: path.join(tmpDir, 'store.json'),
    webhookSecret: SECRET, sseMaxConnMs: 700, sseHeartbeatMs: 200, quiet: true,
  });
});

after(async () => {
  await dash?.close();
  await bse?.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Minimal SSE reader on top of fetch; resolves when `predicate(event)` is true. */
function waitForEvent(url, predicate, { timeoutMs = 10000, lastEventId } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return (async () => {
    const res = await fetch(url, { signal: ctrl.signal, headers: lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {} });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const seen = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return { found: null, seen, closed: true };
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evt = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) evt.type = line.slice(7);
            if (line.startsWith('data: ')) evt.data = JSON.parse(line.slice(6));
            if (line.startsWith('id: ')) evt.id = Number(line.slice(4));
          }
          if (!evt.type) continue;
          seen.push(evt);
          if (predicate(evt)) return { found: evt, seen };
        }
      }
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  })();
}

test('GET /getTrades on the mock returns 202 immediately (never holds the connection)', async () => {
  const t0 = Date.now();
  const res = await fetch(`${bse.url()}/getTrades?delayMs=60000`);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.jobId);
  assert.ok(Date.now() - t0 < 1000);
  const r2 = await fetch(`${bse.url()}/getTrades/jobs/${body.jobId}/results`);
  assert.equal(r2.status, 409, 'results are not available before the job is ready');
});

test('full flow: dashboard serves instantly mid-pull, then trades are pushed on completion', async () => {
  const events = waitForEvent(`${dash.url()}/api/events`, (e) => e.type === 'trades-ingested', { timeoutMs: 15000 });

  const t0 = Date.now();
  const start = await fetch(`${dash.url()}/api/pulls`, { method: 'POST' });
  assert.equal(start.status, 202);
  const { pull } = await start.json();
  assert.equal(pull.status, 'PENDING');
  assert.ok(Date.now() - t0 < 1000, 'starting a pull is instant');

  // While the pull is running the dashboard answers instantly from its local store.
  const t1 = Date.now();
  const mid = await (await fetch(`${dash.url()}/api/trades`)).json();
  assert.ok(Date.now() - t1 < 500);
  assert.equal(mid.trades.length, 0);
  const st = await (await fetch(`${dash.url()}/api/state`)).json();
  assert.equal(st.activePull.id, pull.id);

  // A second concurrent pull is rejected.
  assert.equal((await fetch(`${dash.url()}/api/pulls`, { method: 'POST' })).status, 409);

  // The SSE stream is recycled every 700 ms in this test, so follow reconnects like a browser does.
  let lastId = 0;
  let found = null;
  const deadline = Date.now() + 15000;
  while (!found && Date.now() < deadline) {
    const r = await waitForEvent(`${dash.url()}/api/events`, (e) => e.type === 'trades-ingested', { lastEventId: lastId });
    for (const e of r.seen) if (e.id) lastId = Math.max(lastId, e.id);
    found = r.found;
  }
  assert.ok(found, 'trades-ingested was pushed');
  assert.ok(found.data.newCount >= 2500);
  await events.catch(() => {});

  const after1 = await (await fetch(`${dash.url()}/api/trades`)).json();
  assert.equal(after1.trades.length, found.data.newCount);
  const ids = new Set(after1.trades.map((t) => t.tradeId));
  assert.equal(ids.size, after1.trades.length, 'no duplicate trades');

  // Second pull: only genuinely new trades are added, and the delta endpoint returns just those.
  const seqBefore = after1.lastSeq;
  await fetch(`${dash.url()}/api/pulls`, { method: 'POST' });
  let second = null;
  lastId = 0;
  while (!second && Date.now() < deadline + 15000) {
    const r = await waitForEvent(`${dash.url()}/api/events`, (e) => e.type === 'trades-ingested', { lastEventId: lastId });
    for (const e of r.seen) if (e.id) lastId = Math.max(lastId, e.id);
    second = r.found && r.found.data.fromSeq >= seqBefore ? r.found : null;
  }
  assert.ok(second);
  assert.ok(second.data.newCount > 0 && second.data.newCount < 500);
  const delta = await (await fetch(`${dash.url()}/api/trades?afterSeq=${seqBefore}`)).json();
  assert.equal(delta.trades.length, second.data.newCount);
});

test('SSE replays missed events from Last-Event-ID and closes before 30 s', async () => {
  const t0 = Date.now();
  const r = await waitForEvent(`${dash.url()}/api/events`, () => false, { lastEventId: 1 });
  assert.ok(r.closed, 'server ends the stream itself');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.seen.some((e) => e.id && e.id > 1), 'buffered events were replayed');
  assert.ok(r.seen.some((e) => e.type === 'hello'));
});

test('webhook with a bad signature is rejected', async () => {
  const body = JSON.stringify({ event: 'trades.ready', jobId: 'x', status: 'READY' });
  const bad = await fetch(`${dash.url()}/webhooks/bse`, { method: 'POST', body, headers: { 'X-BSE-Signature': 'sha256=nope' } });
  assert.equal(bad.status, 401);
  const good = await fetch(`${dash.url()}/webhooks/bse`, { method: 'POST', body, headers: { 'X-BSE-Signature': sign(SECRET, body) } });
  assert.equal(good.status, 202);
});

test('mock network kills connections older than the configured limit', async () => {
  const killer = startBseMock({ port: 0, host: '127.0.0.1', maxConnMs: 300, baseTrades: 10, quiet: true });
  await killer.ready;
  const { port } = killer.server.address();
  const t0 = Date.now();
  await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('close', resolve);
    sock.on('error', () => {});
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 250 && elapsed < 2000, `killed after ${elapsed} ms`);
  await killer.close();
});

test('state persists across a dashboard restart', async () => {
  const before = await (await fetch(`${dash.url()}/api/state`)).json();
  const again = await startDashboard({ port: 0, host: '127.0.0.1', bseBaseUrl: bse.url(), dataFile: path.join(tmpDir, 'store.json'), webhookSecret: SECRET, quiet: true });
  const st = await (await fetch(`${again.url()}/api/state`)).json();
  assert.equal(st.stats.totalTrades, before.stats.totalTrades);
  await again.close();
});
