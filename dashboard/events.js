import crypto from 'node:crypto';

export class EventHub {
  constructor({ bufferSize = 500, maxConnMs = 25000, heartbeatMs = 10000, helloState = () => ({}) } = {}) {
    this.clients = new Set();
    this.buffer = [];
    this.bufferSize = bufferSize;
    this.lastId = 0;
    this.maxConnMs = maxConnMs;
    this.heartbeatMs = heartbeatMs;
    this.helloState = helloState;
    this.bootId = crypto.randomUUID();
  }

  static format({ id, type, data }) {
    return `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  publish(type, data) {
    const evt = { id: ++this.lastId, type, data };
    this.buffer.push(evt);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    const frame = EventHub.format(evt);
    for (const c of this.clients) c.res.write(frame);
    return evt;
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    res.write('retry: 1000\n\n');

    // Replay missed events (if the client is resuming and we still have them buffered).
    const lastSeen = Number(req.headers['last-event-id'] || 0);
    if (lastSeen && lastSeen <= this.lastId) {
      for (const evt of this.buffer) if (evt.id > lastSeen) res.write(EventHub.format(evt));
    }
    // `hello` has no id (doesn't move Last-Event-ID) and carries the current lastSeq, so a
    // client can always detect and close any gap (e.g. server restart, buffer overflow).
    res.write(EventHub.format({ type: 'hello', data: { bootId: this.bootId, ...this.helloState() } }));

    const client = { res };
    this.clients.add(client);

    const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), this.heartbeatMs);
    heartbeat.unref();
    const recycle = this.maxConnMs > 0 ? setTimeout(() => res.end(), this.maxConnMs) : null;
    recycle?.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      if (recycle) clearTimeout(recycle);
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  closeAll() {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
