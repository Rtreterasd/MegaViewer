const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const crypto = require("node:crypto");
const path = require("node:path");
function safeName(name) {
  let result = path.posix
    .basename(String(name).replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result))
    result = "_" + (result || "file");
  return result.slice(0, 180);
}
class Downloads {
  constructor({ historyFile, onChange = () => {} }) {
    this.historyFile = historyFile;
    this.onChange = onChange;
    this.jobs = [];
    this.active = null;
    this.playing = false;
    this.closing = false;
    this.saveChain = Promise.resolve();
  }
  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.historyFile, "utf8"));
      this.jobs = saved
        .slice(0, 100)
        .map((j) => ({
          ...j,
          status: ["queued", "downloading", "paused"].includes(j.status)
            ? "interrupted"
            : j.status,
        }));
    } catch {}
  }
  list() {
    return this.jobs.map(({ source, stream, controller, done, ...j }) => j);
  }
  emit() {
    this.onChange(this.list());
  }
  save() {
    const data = JSON.stringify(this.list());
    this.saveChain = this.saveChain
      .then(async () => {
        const temp = this.historyFile + ".tmp";
        await fs.writeFile(temp, data);
        await fs.rename(temp, this.historyFile);
      })
      .catch(() => {});
    return this.saveChain;
  }
  add(item, destination) {
    if (
      this.jobs.some(
        (j) =>
          j.path === destination &&
          ["queued", "downloading", "paused"].includes(j.status),
      )
    )
      throw Error("Этот файл уже загружается");
    const job = {
      id: crypto.randomUUID(),
      name: item.meta.name,
      path: destination,
      size: item.meta.size,
      loaded: 0,
      status: "queued",
      error: null,
      created: Date.now(),
      speed: 0,
      source: item.file,
    };
    this.jobs.unshift(job);
    this.emit();
    this.save();
    this.pump();
    return job.id;
  }
  setPlaying(value) {
    this.playing = !!value;
    if (this.active && ["downloading", "paused"].includes(this.active.status)) {
      this.active.status = this.playing ? "paused" : "downloading";
      this.emit();
    }
    this.pump();
  }
  cancel(id) {
    const j = this.jobs.find((j) => j.id === id);
    if (!j || !["queued", "downloading", "paused"].includes(j.status)) return;
    j.status = "cancelled";
    j.controller?.abort();
    j.stream?.destroy();
    this.emit();
    this.save();
  }
  retry(id) {
    const j = this.jobs.find((j) => j.id === id);
    if (j === this.active) throw Error("Дождитесь завершения отмены");
    if (!j?.source || !["error", "cancelled"].includes(j.status))
      throw Error("Повторите скачивание из каталога");
    j.loaded = 0;
    j.status = "queued";
    j.error = null;
    this.emit();
    this.save();
    this.pump();
  }
  pump() {
    if (this.active || this.playing || this.closing) return;
    const job = [...this.jobs].reverse().find((j) => j.status === "queued");
    if (!job) return;
    this.active = job;
    job.done = this.run(job).finally(() => {
      this.active = null;
      this.pump();
    });
  }
  async run(job) {
    const temp = job.path + "." + job.id + ".part";
    let last = Date.now(),
      previous = 0;
    job.controller = new AbortController();
    const controller = job.controller;
    job.status = "downloading";
    this.emit();
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (this.playing) {
        lastData = Date.now();
        return;
      }
      if (Date.now() - lastData > 30000)
        job.stream?.destroy(
          Error("MEGA не передаёт данные. Повторите скачивание."),
        );
    }, 1000);
    try {
      const stream = job.source.download({
        forceHttps: true,
        maxConnections: 1,
      });
      job.stream = stream;
      const progress = new Transform({
        transform: (chunk, _, callback) => {
          const consume = () => {
            if (controller.signal.aborted) return callback(Error("Отменено"));
            if (this.playing) {
              setTimeout(consume, 150);
              return;
            }
            job.loaded += chunk.length;
            const now = Date.now();
            lastData = now;
            if (now - last >= 250) {
              job.speed = ((job.loaded - previous) * 1000) / (now - last);
              previous = job.loaded;
              last = now;
              this.emit();
            }
            callback(null, chunk);
          };
          consume();
        },
      });
      await pipeline(
        stream,
        progress,
        createWriteStream(temp, { flags: "wx" }),
        { signal: job.controller.signal },
      );
      if (job.loaded !== job.size) throw Error("MEGA вернула неполный файл");
      await fs.rename(temp, job.path);
      job.status = "completed";
      job.speed = 0;
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "error";
        job.error = error.message;
      }
      await fs.rm(temp, { force: true }).catch(() => {});
    } finally {
      clearInterval(watchdog);
      delete job.stream;
      delete job.controller;
      this.emit();
      await this.save();
    }
  }
  async shutdown() {
    this.closing = true;
    for (const j of this.jobs) this.cancel(j.id);
    await this.active?.done;
    await this.saveChain;
  }
}
module.exports = { Downloads, safeName };
