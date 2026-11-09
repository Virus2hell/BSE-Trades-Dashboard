// Dashboard client.
//
// 1. On load: GET /api/state + GET /api/trades -> render immediately from the local store.
// 2. Open an EventSource on /api/events. The server PUSHES:
//      hello           -> on every (re)connect; carries lastSeq so we can close any gap
//      pull-status     -> a pull changed state (REQUESTED / PENDING / FETCHING / COMPLETED / FAILED)
//      trades-ingested -> a pull finished; we fetch just the delta (?afterSeq=<our lastSeq>)
// No polling: the browser never asks "anything new?" on a timer. (The only timer below
// ticks the local ETA countdown text — it makes no network requests.)

const $ = (id) => document.getElementById(id);
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const compactInr = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN');
const timeFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });

const state = {
  trades: [],
  ids: new Set(),
  lastSeq: 0,
  stats: null,
  activePull: null,
  recentPulls: [],
  fresh: new Set(),
  search: '',
  side: '',
  sortKey: 'timestamp',
  sortDir: 'desc',
  page: 1,
  pageSize: 50,
};

// ---------- data ----------
async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202 && res.status !== 409) throw new Error(body.error || `HTTP ${res.status}`);
  return { status: res.status, body };
}

function addTrades(list, { markFresh = false } = {}) {
  let added = 0;
  for (const t of list) {
    if (state.ids.has(t.tradeId)) continue;
    state.ids.add(t.tradeId);
    state.trades.push(t);
    if (markFresh) state.fresh.add(t.tradeId);
    added += 1;
  }
  for (const t of list) state.lastSeq = Math.max(state.lastSeq, t.ingestSeq || 0);
  return added;
}

// Serialize delta syncs so concurrent events never double-fetch the same range.
let syncChain = Promise.resolve(0);
function syncTrades(opts = {}) {
  syncChain = syncChain
    .catch(() => 0)
    .then(async () => {
      const { body } = await getJSON(`/api/trades?afterSeq=${state.lastSeq}`);
      const added = addTrades(body.trades, opts);
      state.lastSeq = Math.max(state.lastSeq, body.lastSeq);
      if (added) render();
      return added;
    });
  return syncChain;
}

async function fullResync() {
  state.trades = [];
  state.ids.clear();
  state.lastSeq = 0;
  await syncTrades();
  render();
}

async function refreshState() {
  const { body } = await getJSON('/api/state');
  applyState(body);
}

function applyState(s) {
  if (s.stats) state.stats = s.stats;
  if ('activePull' in s) state.activePull = s.activePull;
  if (s.recentPulls) state.recentPulls = s.recentPulls;
  renderStats();
  renderPull();
  renderHistory();
}

// ---------- push channel ----------
let downTimer = null;
function setConn(kind) {
  const el = $('conn');
  if (kind === 'live') {
    clearTimeout(downTimer);
    downTimer = null;
    el.dataset.state = 'live';
    $('connText').textContent = 'Live';
  } else if (!downTimer) {
    // The server recycles the stream every ~25 s (network kills >30 s connections) and the
    // browser reconnects within ~1 s. Only show "reconnecting" if it takes noticeably longer.
    downTimer = setTimeout(() => {
      el.dataset.state = 'down';
      $('connText').textContent = 'Reconnecting…';
    }, 3000);
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn('live');
  es.onerror = () => setConn('down'); // EventSource retries automatically (Last-Event-ID is sent)

  es.addEventListener('hello', async (e) => {
    setConn('live');
    const d = JSON.parse(e.data);
    if (d.lastSeq < state.lastSeq) return fullResync(); // server store was reset
    if (d.lastSeq > state.lastSeq) {
      const added = await syncTrades({ markFresh: state.trades.length > 0 });
      if (added) toast(`${int.format(added)} trades synced`);
    }
    refreshState();
  });

  es.addEventListener('pull-status', (e) => {
    const pull = JSON.parse(e.data);
    const ACTIVE = ['REQUESTED', 'PENDING', 'FETCHING'];
    if (ACTIVE.includes(pull.status)) state.activePull = pull;
    else if (state.activePull?.id === pull.id) state.activePull = null;
    const i = state.recentPulls.findIndex((p) => p.id === pull.id);
    if (i === -1) state.recentPulls.unshift(pull);
    else state.recentPulls[i] = pull;
    if (pull.status === 'FAILED') toast(`Pull failed: ${pull.error || 'unknown error'}`);
    renderPull();
    renderHistory();
  });

  es.addEventListener('trades-ingested', async (e) => {
    const d = JSON.parse(e.data);
    state.stats = d.stats;
    const added = await syncTrades({ markFresh: true });
    renderStats(true);
    toast(added ? `${int.format(added)} new trades arrived from BSE` : 'Pull complete — no new trades');
  });
}

// ---------- rendering ----------
function renderStats(bump = false) {
  const s = state.stats;
  if (!s) return;
  const set = (id, text) => {
    const el = $(id);
    if (el.textContent !== text && bump) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
    el.textContent = text;
  };
  set('statTrades', int.format(s.totalTrades));
  set('statTurnover', '₹' + compactInr.format(s.turnover));
  set('statClients', int.format(s.uniqueClients));
  set('statLastPull', s.lastPullCompletedAt ? timeFmt.format(new Date(s.lastPullCompletedAt)) : 'Never');
}

function fmtDuration(ms) {
  if (ms <= 0) return 'any moment now';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function renderPull() {
  const p = state.activePull;
  const badge = $('pullBadge');
  const btn = $('pullBtn');
  const progress = $('pullProgress');
  if (!p) {
    badge.textContent = 'IDLE';
    badge.dataset.s = 'IDLE';
    $('pullHeadline').textContent = 'No pull in progress';
    $('pullDetail').textContent = 'Showing everything pulled so far. Start a pull to fetch the latest trades from BSE.';
    progress.hidden = true;
    btn.disabled = false;
    btn.textContent = 'Pull from BSE';
    return;
  }
  badge.textContent = p.status;
  badge.dataset.s = p.status;
  btn.disabled = true;
  btn.textContent = 'Pull in progress…';
  progress.hidden = false;
  if (p.status === 'FETCHING') {
    $('pullHeadline').textContent = 'BSE finished — downloading results';
    $('pullDetail').textContent = 'Fetching result pages in short requests…';
    $('pullBar').style.width = '100%';
  } else {
    const start = new Date(p.requestedAt).getTime();
    const eta = p.estimatedReadyAt ? new Date(p.estimatedReadyAt).getTime() : null;
    $('pullHeadline').textContent = 'Pull running on BSE';
    if (eta) {
      const now = Date.now();
      const pct = Math.min(99, Math.max(2, ((now - start) / (eta - start || 1)) * 100));
      $('pullBar').style.width = pct + '%';
      $('pullDetail').textContent =
        `Started ${timeFmt.format(new Date(start))} · ready in ~${fmtDuration(eta - now)}. ` +
        `You can keep using the dashboard — new trades will appear automatically.`;
    } else {
      $('pullDetail').textContent = 'Waiting for BSE to accept the request…';
    }
  }
}

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  if (!state.recentPulls.length) {
    ul.innerHTML = '<li>No pulls yet.</li>';
    return;
  }
  for (const p of state.recentPulls.slice(0, 8)) {
    const li = document.createElement('li');
    const when = timeFmt.format(new Date(p.requestedAt));
    let detail = '';
    if (p.status === 'COMPLETED') detail = `${int.format(p.newCount)} new · ${int.format(p.receivedCount)} received`;
    if (p.status === 'FAILED') detail = p.error || '';
    li.innerHTML = `<span class="badge" data-s="${p.status}">${p.status}</span><span class="when"></span><span class="d"></span>`;
    li.querySelector('.when').textContent = when;
    li.querySelector('.d').textContent = detail;
    ul.appendChild(li);
  }
}

function filtered() {
  const q = state.search.trim().toUpperCase();
  let list = state.trades;
  if (q || state.side) {
    list = list.filter(
      (t) =>
        (!state.side || t.side === state.side) &&
        (!q || t.tradeId.includes(q) || t.client.toUpperCase().includes(q) || t.symbol.includes(q))
    );
  }
  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const val = (t) => (key === 'value' ? t.price * t.quantity : t[key]);
  return list.slice().sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function render() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const slice = list.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  const tbody = $('rows');
  const frag = document.createDocumentFragment();
  for (const t of slice) {
    const tr = document.createElement('tr');
    if (state.fresh.has(t.tradeId)) tr.className = 'fresh';
    const cells = [
      [t.tradeId],
      [t.client],
      [t.symbol],
      [t.side, t.side],
      [int.format(t.quantity), 'num'],
      [inr.format(t.price), 'num'],
      [inr.format(t.price * t.quantity), 'num'],
      [timeFmt.format(new Date(t.timestamp))],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);

  $('empty').hidden = state.trades.length > 0;
  $('resultCount').textContent = `${int.format(list.length)} of ${int.format(state.trades.length)} trades`;
  $('pageInfo').textContent = `Page ${state.page} of ${pages}`;
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pages;
  document.querySelectorAll('th[data-key]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.key === state.sortKey ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  if (state.fresh.size) {
    clearTimeout(render.freshTimer);
    render.freshTimer = setTimeout(() => {
      state.fresh.clear();
      document.querySelectorAll('tr.fresh').forEach((tr) => tr.classList.remove('fresh'));
    }, 15000);
  }
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- UI events ----------
$('pullBtn').addEventListener('click', async () => {
  $('pullBtn').disabled = true;
  try {
    const { status, body } = await getJSON('/api/pulls', { method: 'POST' });
    if (status === 409) toast('A pull is already in progress');
    if (body.pull) {
      state.activePull = ['REQUESTED', 'PENDING', 'FETCHING'].includes(body.pull.status) ? body.pull : null;
      renderPull();
    }
  } catch (err) {
    toast(`Could not start pull: ${err.message}`);
    renderPull();
  }
});

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    state.page = 1;
    render();
  }, 150);
});
$('sideFilter').addEventListener('change', (e) => {
  state.side = e.target.value;
  state.page = 1;
  render();
});
$('prev').addEventListener('click', () => { state.page -= 1; render(); });
$('next').addEventListener('click', () => { state.page += 1; render(); });
document.querySelectorAll('th[data-key]').forEach((th) =>
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      state.sortKey = key;
      state.sortDir = ['tradeId', 'client', 'symbol', 'side'].includes(key) ? 'asc' : 'desc';
    }
    render();
  })
);

// Local-only ticker for the ETA countdown text (no network requests).
setInterval(() => {
  if (state.activePull && state.activePull.status !== 'FETCHING') renderPull();
}, 1000);

// ---------- boot ----------
(async function boot() {
  try {
    const [{ body: s }, { body: t }] = await Promise.all([getJSON('/api/state'), getJSON('/api/trades')]);
    addTrades(t.trades);
    state.lastSeq = Math.max(state.lastSeq, t.lastSeq);
    applyState(s);
    render();
  } catch (err) {
    toast(`Failed to load dashboard: ${err.message}`);
  }
  connect();
})();
