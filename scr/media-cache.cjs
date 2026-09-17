const { Readable } = require("node:stream");
// Publish bytes immediately; completed blocks are retained in a bounded LRU.
class MediaCache {
  constructor({
    chunkSize = 1024 * 1024,
    maxBytes = 96 * 1024 * 1024,
    parallel = 3,
    timeoutMs = 12000,
  } = {}) {
    Object.assign(this, { chunkSize, maxBytes, parallel, timeoutMs });
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.bytes = 0;
    this.running = 0;
    this.generation = 0;
  }
  entry(item, index, priority = false) {
    const key = item.meta.cache + ":" + index;
    if (this.cache.has(key)) {
      const data = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, data);
      return { parts: [data], received: data.length, done: true };
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const e = {
      key,
      item,
      index,
      parts: [],
      received: 0,
      done: false,
      error: null,
      waiters: new Set(),
      generation: this.generation,
    };
    e.notify = () => {
      for (const r of e.waiters) r();
      e.waiters.clear();
    };
    this.pending.set(key, e);
    if (priority) this.queue.unshift(e);
    else this.queue.push(e);
    this.pump();
    return e;
  }
  pump() {
    while (this.running < this.parallel && this.queue.length) {
      const e = this.queue.shift();
      if (e.generation !== this.generation) continue;
      this.running++;
      this.read(e).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  async read(e) {
    const start = e.index * this.chunkSize,
      end = Math.min(e.item.meta.size - 1, start + this.chunkSize - 1);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (e.generation !== this.generation) throw Error("Загрузка отменена");
        let timer;
        try {
          const stream = e.item.file.download({
            start: start + e.received,
            end,
            forceHttps: true,
            maxConnections: 1,
          });
          e.stream = stream;
          timer = setTimeout(
            () => stream.destroy(Error("MEGA: тайм-аут загрузки")),
            this.timeoutMs,
          );
          for await (const b of stream) {
            timer.refresh();
            if (e.generation !== this.generation)
              throw Error("Загрузка отменена");
            e.parts.push(b);
            e.received += b.length;
            e.notify();
          }
          if (e.received !== end - start + 1)
            throw Error("MEGA: неполный блок видео");
          break;
        } catch (error) {
          if (
            attempt ||
            e.generation !== this.generation ||
            /EBLOCKED|ENOENT|quota|509|EACCESS/i.test(error.message)
          )
            throw error;
          e.item.file.invalidateDownloadUrl?.();
        } finally {
          clearTimeout(timer);
        }
      }
      if (e.generation !== this.generation) throw Error("Загрузка отменена");
      const data = Buffer.concat(e.parts);
      this.cache.set(e.key, data);
      this.bytes += data.length;
      while (this.bytes > this.maxBytes && this.cache.size) {
        const first = this.cache.keys().next().value;
        this.bytes -= this.cache.get(first).length;
        this.cache.delete(first);
      }
    } catch (error) {
      e.error = error;
    } finally {
      e.done = true;
      e.notify();
      if (this.pending.get(e.key) === e) this.pending.delete(e.key);
    }
  }
  async chunk(item, index) {
    const e = this.entry(item, index, true);
    while (!e.done) await new Promise((r) => e.waiters.add(r));
    if (e.error) throw e.error;
    return Buffer.concat(e.parts);
  }
  range(item, start, end) {
    const self = this,
      controller = new AbortController(),
      generation = this.generation;
    const output = Readable.from(
      (async function* () {
        const last = Math.floor(end / self.chunkSize);
        for (let i = Math.floor(start / self.chunkSize); i <= last; i++) {
          if (controller.signal.aborted || generation !== self.generation)
            return;
          const e = self.entry(item, i, true);
          for (let j = i + 1; j <= Math.min(last, i + 1); j++)
            self.entry(item, j);
          let part = 0,
            offset = i * self.chunkSize;
          while (true) {
            if (controller.signal.aborted || generation !== self.generation)
              return;
            while (part < e.parts.length) {
              const data = e.parts[part++],
                from = Math.max(0, start - offset),
                to = Math.min(data.length, end - offset + 1);
              offset += data.length;
              if (to > from) yield data.subarray(from, to);
              if (offset > end) return;
            }
            if (e.error) throw e.error;
            if (e.done) break;
            await new Promise((r) => {
              const wake = () => {
                controller.signal.removeEventListener("abort", wake);
                e.waiters.delete(wake);
                r();
              };
              e.waiters.add(wake);
              controller.signal.addEventListener("abort", wake, { once: true });
            });
          }
        }
      })(),
      { objectMode: false, highWaterMark: 128 * 1024 },
    );
    const destroy = output.destroy.bind(output);
    output.destroy = (error) => {
      controller.abort();
      return destroy(error);
    };
    return output;
  }
  clear() {
    this.generation++;
    for (const e of this.pending.values()) {
      e.error = Error("Загрузка отменена");
      e.done = true;
      e.stream?.destroy();
      e.notify();
    }
    this.pending.clear();
    this.queue = [];
    this.cache.clear();
    this.bytes = 0;
  }
}
module.exports = { MediaCache };
