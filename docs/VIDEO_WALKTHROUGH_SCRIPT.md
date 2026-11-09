# Video walkthrough: suggested script (about 5–7 minutes)

Record your screen, for example with OBS or Loom, and talk through it in your own words.

## 1. The problem (30 s)
"A BSE pull takes 15 minutes, but our network kills any HTTP connection after 30 seconds. So nothing can wait on an open request. Not the backend, and not the browser."

## 2. Architecture (1–2 min)
Open `ARCHITECTURE.md` and walk through the sequence diagram:
- `/getTrades` returns **202 + jobId** right away. It's an async job.
- When the job is done, BSE **calls our webhook**. That way there's no polling and no cron.
- We download the results in **pages**, so every request is short.
- The dashboard always reads from the **local store**, so it opens instantly.
- New trades are **pushed with SSE**. Streams are recycled at 25 s, and the browser resumes with `Last-Event-ID`.

## 3. Live demo (2–3 min)
1. Run `npm run demo` (20 s pull) and show the logs of both services.
2. Open http://localhost:3000. It loads instantly, with an empty table on the first run.
3. Click **Pull from BSE**. Show the PENDING badge and the countdown. Open a **second tab**: it also opens instantly and shows the pull in progress.
4. Open DevTools → Network. Show that there are **no repeating requests**, only the `events` stream, which reconnects about every 25 s.
5. When the pull completes, about 3,000 trades appear in **both tabs** without a refresh. Show the toast and the highlighted rows.
6. Pull again. Only about 40–150 new trades are added (show the counter). There are no duplicates.
7. Stop the servers with Ctrl+C, restart them, and reload. The data is still there and loads instantly.

## 4. Code tour (1–2 min)
- `bse-mock/server.js`: `startJob`, `completeJob`, `deliverWebhook` (retries), paged `results`, and the 30 s connection killer.
- `dashboard/pullService.js`: `startPull` → `handleWebhook` → `ingest`, plus `reconcile` (one-shot crash recovery).
- `dashboard/store.js`: upsert by `tradeId` and `ingestSeq` for deltas.
- `dashboard/events.js`: SSE push, heartbeat, 25 s recycle, `Last-Event-ID` replay.
- `dashboard/public/app.js`: the `EventSource` handlers and the delta fetch.

## 5. Tests and trade-offs (30–60 s)
- Run `npm test` and show all tests passing.
- Mention what you'd do in production: Postgres, Redis pub/sub for multiple instances, a queue-based ingestion worker, and a signed webhook with a replay-protection timestamp.
