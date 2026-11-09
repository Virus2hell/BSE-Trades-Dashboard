
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PULL_HISTORY = 50;

export class TradeStore {
  constructor(file) {
    this.file = file;
    this.trades = new Map(); // tradeId -> trade (insertion order == ingestSeq order)
    this.ordered = []; // same trades, ordered by ingestSeq (for fast "since" queries)
    this.seq = 0;
    this.pulls = []; // newest first
    this._writeChain = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.seq = data.seq ?? 0;
      this.pulls = data.pulls ?? [];
      for (const t of data.trades ?? []) {
        this.trades.set(t.tradeId, t);
        this.ordered.push(t);
      }
      this.ordered.sort((a, b) => a.ingestSeq - b.ingestSeq);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /** Insert-or-update by tradeId. Idempotent: re-ingesting the same page changes nothing. */
  upsert(incoming) {
    const inserted = [];
    let updated = 0;
    const ingestedAt = new Date().toISOString();
    for (const t of incoming) {
      if (!t || !t.tradeId) continue;
      const existing = this.trades.get(t.tradeId);
      if (!existing) {
        const rec = { ...t, ingestSeq: ++this.seq, ingestedAt };
        this.trades.set(rec.tradeId, rec);
        this.ordered.push(rec);
        inserted.push(rec);
      } else if (existing.price !== t.price || existing.quantity !== t.quantity || existing.side !== t.side) {
        // Exchange corrected a trade: update in place (keeps its seq; announced via `updatedCount`).
        Object.assign(existing, t);
        updated += 1;
      }
    }
    return { inserted, updated };
  }

  /** Trades ingested after `seq` (binary search over the seq-ordered array). */
  since(seq = 0) {
    if (seq <= 0) return this.ordered.slice();
    let lo = 0;
    let hi = this.ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ordered[mid].ingestSeq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return this.ordered.slice(lo);
  }

  savePull(pull) {
    const i = this.pulls.findIndex((p) => p.id === pull.id);
    if (i === -1) this.pulls.unshift(pull);
    else this.pulls[i] = pull;
    this.pulls.length = Math.min(this.pulls.length, MAX_PULL_HISTORY);
    return pull;
  }

  stats() {
    let turnover = 0;
    const clients = new Set();
    const symbols = new Set();
    for (const t of this.ordered) {
      turnover += t.price * t.quantity;
      clients.add(t.client);
      symbols.add(t.symbol);
    }
    const lastCompleted = this.pulls.find((p) => p.status === 'COMPLETED');
    return {
      totalTrades: this.ordered.length,
      turnover: Math.round(turnover * 100) / 100,
      uniqueClients: clients.size,
      uniqueSymbols: symbols.size,
      lastPullCompletedAt: lastCompleted?.completedAt ?? null,
    };
  }

  /** Atomic write (tmp file + rename), serialized so writes never interleave. */
  persist() {
    if (!this.file) return Promise.resolve();
    const snapshot = JSON.stringify({ seq: this.seq, pulls: this.pulls, trades: this.ordered });
    this._writeChain = this._writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, this.file);
      });
    return this._writeChain;
  }
}
