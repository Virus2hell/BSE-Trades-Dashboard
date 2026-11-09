import crypto from 'node:crypto';

const ACTIVE = new Set(['REQUESTED', 'PENDING', 'FETCHING']);

export class PullService {
  constructor({ store, hub, bseBaseUrl, publicUrl, fetchTimeoutMs = 20000, pageSize = 1000, say = () => {} }) {
    this.store = store;
    this.hub = hub;
    this.bseBaseUrl = bseBaseUrl.replace(/\/$/, '');
    this.publicUrl = publicUrl;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.pageSize = pageSize;
    this.say = say;
    this.ingesting = new Set(); // bseJobIds currently being ingested (dedupe webhook retries)
  }

  active() {
    return this.store.pulls.find((p) => ACTIVE.has(p.status)) ?? null;
  }

  _update(pull, patch) {
    Object.assign(pull, patch, { updatedAt: new Date().toISOString() });
    this.store.savePull(pull);
    this.hub.publish('pull-status', pull);
    return pull;
  }

  async _get(url, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        // Every BSE call is bounded well below the 30 s network limit.
        const res = await fetch(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 202) {
          const err = new Error(body.error || `HTTP ${res.status}`);
          err.status = res.status;
          if (res.status < 500) throw Object.assign(err, { fatal: true });
          throw err;
        }
        return { status: res.status, body };
      } catch (err) {
        lastErr = err;
        if (err.fatal) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i)); // bounded backoff, not a polling loop
      }
    }
    throw lastErr;
  }

  async startPull() {
    const current = this.active();
    if (current) return { conflict: true, pull: current };

    const pull = this._update(
      { id: crypto.randomUUID(), status: 'REQUESTED', requestedAt: new Date().toISOString() },
      {}
    );
    try {
      const url = new URL(`${this.bseBaseUrl}/getTrades`);
      url.searchParams.set('callbackUrl', `${this.publicUrl.replace(/\/$/, '')}/webhooks/bse`);
      const { body } = await this._get(url, 2);
      this._update(pull, { status: 'PENDING', bseJobId: body.jobId, estimatedReadyAt: body.estimatedReadyAt });
      this.say(`pull ${pull.id} accepted by BSE as job ${body.jobId}, ETA ${body.estimatedReadyAt}`);
    } catch (err) {
      this._update(pull, { status: 'FAILED', error: `Could not start pull: ${err.message}` });
    }
    await this.store.persist();
    return { conflict: false, pull };
  }

  async handleWebhook(payload) {
    const pull = this.store.pulls.find((p) => p.bseJobId === payload.jobId);
    if (!pull) {
      this.say(`webhook for unknown job ${payload.jobId} ignored`);
      return;
    }
    if (pull.status === 'COMPLETED' || this.ingesting.has(payload.jobId)) return; // idempotent
    if (payload.status && payload.status !== 'READY') {
      this._update(pull, { status: 'FAILED', error: `BSE reported ${payload.status}` });
      await this.store.persist();
      return;
    }
    await this.ingest(pull);
  }

  async ingest(pull) {
    const jobId = pull.bseJobId;
    if (this.ingesting.has(jobId)) return;
    this.ingesting.add(jobId);
    const fromSeq = this.store.seq;
    let inserted = 0;
    let updated = 0;
    let received = 0;
    try {
      this._update(pull, { status: 'FETCHING', fetchStartedAt: new Date().toISOString() });
      let page = 1;
      let totalPages = 1;
      do {
        const url = `${this.bseBaseUrl}/getTrades/jobs/${jobId}/results?page=${page}&pageSize=${this.pageSize}`;
        const { body } = await this._get(url);
        const r = this.store.upsert(body.trades ?? []);
        inserted += r.inserted.length;
        updated += r.updated;
        received += (body.trades ?? []).length;
        totalPages = body.totalPages ?? 1;
        page += 1;
      } while (page <= totalPages);

      this._update(pull, {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        receivedCount: received,
        newCount: inserted,
        updatedCount: updated,
      });
      await this.store.persist();
      this.hub.publish('trades-ingested', {
        pullId: pull.id,
        fromSeq,
        toSeq: this.store.seq,
        newCount: inserted,
        updatedCount: updated,
        stats: this.store.stats(),
      });
      this.say(`pull ${pull.id} COMPLETED: ${received} received, ${inserted} new, ${updated} updated`);
    } catch (err) {
      this._update(pull, { status: 'FAILED', error: `Ingest failed: ${err.message}` });
      await this.store.persist();
      this.say(`pull ${pull.id} FAILED: ${err.message}`);
    } finally {
      this.ingesting.delete(jobId);
    }
  }

  /**
   * Crash recovery, run ONCE at startup (not a loop): if we went down while a pull was
   * in flight, ask BSE once about the job. If it's ready we ingest now; if it's still
   * pending, BSE's webhook (which it retries) will reach us when it's done.
   */
  async reconcile() {
    for (const pull of this.store.pulls.filter((p) => ACTIVE.has(p.status))) {
      if (!pull.bseJobId) {
        this._update(pull, { status: 'FAILED', error: 'Interrupted before BSE accepted the job' });
        continue;
      }
      try {
        const { body } = await this._get(`${this.bseBaseUrl}/getTrades/jobs/${pull.bseJobId}`, 1);
        if (body.status === 'READY') await this.ingest(pull);
        else this._update(pull, { status: 'PENDING' });
      } catch (err) {
        this._update(pull, { status: 'FAILED', error: `Recovery failed: ${err.message}` });
      }
    }
    await this.store.persist();
  }
}
