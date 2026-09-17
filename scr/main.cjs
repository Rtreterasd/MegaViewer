const {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  safeStorage,
  Menu,
  dialog,
  shell,
} = require("electron");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto");
const { File, API } = require("megajs");
const { megaFetch } = require("./transport.cjs");
const { MediaCache } = require("./media-cache.cjs");
const { serverThumbnail } = require("./thumbnail.cjs");
const { Downloads, safeName } = require("./downloads.cjs");
const { cacheDownloadUrl } = require("./download-url.cjs");
const { mp4Patch, patchRange } = require("./mp4-stream.cjs");
let downloads,
  closing = false,
  playbackId = null;
const mediaCache = new MediaCache();
let playing = false;
const thumbTasks = new Map();
API.getGlobalApi().fetch = megaFetch;
const mediaErrors = new Map();
const { describe, validateLink, parseLink, range } = require("./core.cjs");
if (process.argv.some((x) => ["--smoke-test", "--live-test"].includes(x))) {
  const testData = path.join(
    app.getPath("temp"),
    "mega-viewer-test-" + process.pid,
  );
  require("node:fs").mkdirSync(testData, { recursive: true });
  app.setPath("userData", testData);
}
let win, server, base, cacheDir, historyFile;
let nodes = new Map(),
  history = [],
  generation = 0;
const streams = new Set();
const token = crypto.randomBytes(24).toString("hex");
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
async function saveHistory() {
  if (safeStorage.isEncryptionAvailable())
    await fs.writeFile(
      historyFile,
      safeStorage.encryptString(JSON.stringify(history)),
    );
}
async function trimCache() {
  const items = await fs.readdir(cacheDir);
  const stats = await Promise.all(
    items.map(async (name) => ({
      name,
      ...(await fs.stat(path.join(cacheDir, name))),
    })),
  );
  let size = stats.reduce((a, b) => a + b.size, 0);
  for (const f of stats.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (size <= 256 * 1024 * 1024) break;
    await fs.unlink(path.join(cacheDir, f.name)).catch(() => {});
    size -= f.size;
  }
}
function stopStreams() {
  mediaCache.clear();
  for (const s of streams) s.destroy();
  streams.clear();
}
async function openLink(input, atRoot = false) {
  const url = validateLink(input);
  const ticket = ++generation;
  const parsed = parseLink(url);
  const attributes = new Map();
  const api = new API(false, {
    fetch: async (...args) => {
      const response = await megaFetch(...args),
        json = response.json;
      response.json = async () => {
        const data = await json();
        for (const result of Array.isArray(data) ? data : [data]) {
          if (result?.f)
            for (const n of result.f) if (n.fa) attributes.set(n.h, n.fa);
          if (result?.fa) attributes.set("root", result.fa);
        }
        return data;
      };
      return response;
    },
  });
  const options = { api };
  if (atRoot) options.loadedFile = undefined;
  else if (parsed.selectedId) options.loadedFile = parsed.selectedId;
  const file = File.fromURL(parsed.url, options);
  const selected = await Promise.race([
    file.loadAttributes(),
    new Promise((_, reject) => {
      const t = setTimeout(
        () =>
          reject(Error("MEGA не ответила за 45 секунд. Повторите попытку.")),
        45000,
      );
      t.unref();
    }),
  ]);
  if (ticket !== generation) throw Error("Открытие отменено");
  const next = new Map(),
    list = [];
  // MEGAJS populates the shared root even when loadAttributes returns a
  // selected descendant. Retain that root so breadcrumbs can reach siblings.
  const stack = [{ f: file, parent: null }];
  let initialId = "0";
  while (stack.length) {
    const { f, parent } = stack.pop();
    const id = String(list.length);
    if (f === selected) initialId = id;
    const d = describe(f, id, parent);
    d.cache = hash("hq-v2|" + url + "|" + (f.nodeId || f.downloadId || id));
    const fa = attributes.get(
      f.nodeId || (Array.isArray(f.downloadId) ? f.downloadId[1] : "root"),
    );
    d.serverThumb = !!fa?.match(/(?:^|\/)\d+:0\*/);
    d.serverPreview = !!fa?.match(/(?:^|\/)\d+:1\*/);
    if (!f.directory) cacheDownloadUrl(f);
    next.set(id, { file: f, meta: d, fa });
    list.push(d);
    if (f.children)
      for (let i = f.children.length - 1; i >= 0; i--)
        stack.push({ f: f.children[i], parent: id });
  }
  stopStreams();
  nodes = next;
  mediaErrors.clear();
  history = [
    { url, name: list.find((n) => n.id === initialId).name, date: Date.now() },
    ...history.filter((x) => x.url !== url),
  ].slice(0, 20);
  await saveHistory();
  return { nodes: list, initialId, base, history };
}
async function serve(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    if (!u.pathname.startsWith("/" + token + "/")) {
      res.writeHead(403).end();
      return;
    }
    const [, , kind, id] = u.pathname.split("/");
    const item = nodes.get(id);
    if (!item) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (kind === "thumb") {
      try {
        const filename = path.join(cacheDir, item.meta.cache + ".jpg");
        let data = await fs.readFile(filename).catch(() => null);
        if (!data && item.fa && !playing) {
          if (!thumbTasks.has(item.meta.cache)) {
            const task = serverThumbnail(
              item.file,
              item.fa,
              AbortSignal.timeout(10000),
              item.meta.serverPreview ? 1 : 0,
            )
              .catch(() =>
                item.meta.serverPreview
                  ? serverThumbnail(
                      item.file,
                      item.fa,
                      AbortSignal.timeout(8000),
                      0,
                    )
                  : null,
              )
              .then(async (buffer) => {
                if (!buffer) return null;
                const img = nativeImage.createFromBuffer(buffer);
                if (img.isEmpty()) return null;
                const jpeg = (
                  img.getSize().width > 640 ? img.resize({ width: 640 }) : img
                ).toJPEG(92);
                await fs.writeFile(filename, jpeg);
                return jpeg;
              })
              .finally(() => thumbTasks.delete(item.meta.cache));
            thumbTasks.set(item.meta.cache, task);
          }
          data = await thumbTasks.get(item.meta.cache);
        }
        if (!data) {
          res.writeHead(404).end();
          return;
        }
        res.setHeader("Content-Type", "image/jpeg");
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    if (kind !== "media" || item.meta.type === "folder") {
      res.writeHead(404).end();
      return;
    }
    let r;
    try {
      r = range(req.headers.range, item.meta.size);
    } catch {
      res
        .writeHead(416, { "Content-Range": `bytes */${item.meta.size}` })
        .end();
      return;
    }
    res.statusCode = r.partial ? 206 : 200;
    const trace =
      process.env.MEGA_TRACE === "1" && process.argv.includes("--live-test");
    const requestedAt = Date.now();
    if (trace) console.log("RANGE", id, r.start, r.end);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", item.meta.mime);
    res.setHeader("Content-Length", Math.max(0, r.end - r.start + 1));
    if (r.partial)
      res.setHeader(
        "Content-Range",
        `bytes ${r.start}-${r.end}/${item.meta.size}`,
      );
    if (req.method === "HEAD" || !item.meta.size) {
      res.end();
      return;
    }
    let playbackPatch = null;
    if (item.meta.mime === "video/mp4") {
      if (!item.patchTask)
        item.patchTask = mp4Patch(item, mediaCache).catch(() => {
          item.patchTask = null;
          return null;
        });
      playbackPatch = await item.patchTask;
      if (res.destroyed) return;
      if (trace && playbackPatch) console.log("MP4-OPTIMIZED", id);
    }
    const rawStream =
      item.meta.type === "video"
        ? mediaCache.range(item, r.start, r.end)
        : item.file.download({
            start: r.start,
            end: r.end,
            forceHttps: true,
            maxConnections: 1,
          });
    const stream = patchRange(rawStream, r.start, playbackPatch);
    streams.add(stream);
    if (trace) {
      stream.once("data", (b) =>
        console.log("FIRST-BYTES", id, b.length, Date.now() - requestedAt),
      );
      stream.once("end", () =>
        console.log("RANGE-END", id, Date.now() - requestedAt),
      );
      stream.once("error", (e) => console.log("RANGE-ERROR", id, e.message));
    }
    const timer = setTimeout(
      () => stream.destroy(Error("Тайм-аут MEGA")),
      120000,
    );
    stream.on("data", () => timer.refresh());
    stream.on("error", (error) => {
      if (error.name !== "AbortError") mediaErrors.set(id, error.message);
      if (!res.headersSent) res.writeHead(502);
      res.destroy();
    });
    res.on("close", () => {
      clearTimeout(timer);
      streams.delete(stream);
      stream.destroy();
    });
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}
app.whenReady().then(async () => {
  downloads = new Downloads({
    historyFile: path.join(app.getPath("userData"), "downloads.json"),
    onChange: (list) => {
      if (win && !win.isDestroyed())
        win.webContents.send("downloads-changed", list);
    },
  });
  await downloads.init();
  cacheDir = path.join(app.getPath("userData"), "thumbnails");
  historyFile = path.join(app.getPath("userData"), "history.enc");
  await fs.mkdir(cacheDir, { recursive: true });
  try {
    history = JSON.parse(
      safeStorage.decryptString(await fs.readFile(historyFile)),
    );
  } catch {}
  await trimCache();
  const cacheMaintenance = setInterval(
    () => trimCache().catch(() => {}),
    60000,
  );
  cacheMaintenance.unref();
  server = http.createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/${token}`;
  ipcMain.handle("open", (_, url, atRoot) => openLink(url, atRoot === true));
  ipcMain.handle("history", () => history);
  ipcMain.handle("downloads-list", () => downloads.list());
  ipcMain.handle("download-action", (_, action, id) => {
    if (action === "cancel") downloads.cancel(id);
    if (action === "retry") downloads.retry(id);
    if (action === "reveal") {
      const job = downloads.jobs.find((j) => j.id === id);
      if (job?.status === "completed") shell.showItemInFolder(job.path);
    }
    return downloads.list();
  });
  async function saveItem(item) {
    const choice = await dialog.showSaveDialog(win, {
      title: "Скачать файл",
      defaultPath: path.join(
        app.getPath("downloads"),
        safeName(item.meta.name),
      ),
    });
    if (choice.canceled || !choice.filePath) return;
    downloads.add(item, choice.filePath);
    win.webContents.send("show-downloads");
  }
  ipcMain.handle("file-menu", (_, id, key) => {
    const item = nodes.get(id);
    if (
      !item ||
      item.meta.cache !== key ||
      item.meta.type === "folder" ||
      !item.file
    )
      return;
    Menu.buildFromTemplate([
      {
        label: "Скачать файл…",
        click: () =>
          saveItem(item).catch((error) =>
            dialog.showErrorBox("Скачивание", error.message),
          ),
      },
    ]).popup({ window: win });
  });
  ipcMain.handle("download-file", async (_, id, key) => {
    const item = nodes.get(id);
    if (item && item.meta.cache === key && item.file && !item.file.directory)
      await saveItem(item);
  });
  ipcMain.handle("playback", (_, value, id) => {
    const nextId = value ? id : null;
    if (playbackId !== nextId) {
      for (const s of streams) s.destroy();
      streams.clear();
      mediaCache.clear();
    }
    playbackId = nextId;
    playing = !!value;
    downloads.setPlaying(playing);
  });
  ipcMain.handle("retry-media", (_, id) => {
    const item = nodes.get(id);
    item?.file.invalidateDownloadUrl?.();
    mediaErrors.delete(id);
    mediaCache.clear();
  });
  ipcMain.handle("window", (_, action) => {
    if (action === "close") win.close();
    if (action === "minimize") win.minimize();
    if (action === "maximize")
      win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.handle("media-error", (_, id) => mediaErrors.get(id) || null);
  ipcMain.handle("clear-history", async () => {
    history = [];
    await fs.rm(historyFile, { force: true });
    return [];
  });
  ipcMain.handle("clear-cache", async () => {
    for (const n of await fs.readdir(cacheDir))
      await fs.unlink(path.join(cacheDir, n)).catch(() => {});
  });
  ipcMain.handle("put-thumb", async (_, id, data, key) => {
    const item = nodes.get(id);
    if (
      !item ||
      item.meta.cache !== key ||
      typeof data !== "string" ||
      data.length > 1500000 ||
      !data.startsWith("data:image/jpeg;base64,")
    )
      return;
    const img = nativeImage.createFromDataURL(data);
    if (img.isEmpty()) return;
    await fs.writeFile(
      path.join(cacheDir, item.meta.cache + ".jpg"),
      (img.getSize().width > 640 ? img.resize({ width: 640 }) : img).toJPEG(92),
    );
  });
  win = new BrowserWindow({
    frame: false,
    width: 1440,
    height: 940,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#0c1017",
    title: "MEGA Viewer",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  if (process.argv.includes("--live-test"))
    win.webContents.on("console-message", (details) => {
      if (details.message?.startsWith("TEST ")) console.log(details.message);
    });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
  await win.loadFile(path.join(__dirname, "index.html"));
  if (process.argv.includes("--live-test")) {
    try {
      if (!process.env.MEGA_TEST_URL) throw Error("Set MEGA_TEST_URL");
      const result = await win.webContents.executeJavaScript(
        `window.runLiveTest(${JSON.stringify(process.env.MEGA_TEST_URL)},${process.env.MEGA_EXTENDED_TEST === "1"},${Number(process.env.MEGA_VIDEO_INDEX) || 0})`,
      );
      console.log("LIVE", JSON.stringify(result));
      stopStreams();
      app.exit(result.ok ? 0 : 1);
    } catch (e) {
      console.error(e.message);
      app.exit(1);
    }
  }
  if (process.argv.includes("--smoke-test")) {
    try {
      const result =
        await win.webContents.executeJavaScript(`window.runSmoke()`);
      console.log("SMOKE", JSON.stringify(result));
      await new Promise((r) => setTimeout(r, 500));
      await fs.writeFile(
        path.join(app.getPath("temp"), "mega-viewer-smoke.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      app.exit(result.ok ? 0 : 1);
    } catch (e) {
      console.error(e);
      app.exit(1);
    }
  }
});
app.on("window-all-closed", () => {
  stopStreams();
  server?.close();
  app.quit();
});
app.on("before-quit", (event) => {
  if (closing || !downloads) return;
  event.preventDefault();
  closing = true;
  stopStreams();
  downloads.shutdown().finally(() => app.quit());
});
