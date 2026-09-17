const $ = (id) => document.getElementById(id);
let previewPaused = false;
let playerTimer = null,
  currentMediaId = null,
  playerAttempt = 0,
  playerResume = 0,
  downloadsState = [];
let all = [],
  byId = new Map(),
  children = new Map(),
  current = null,
  base = "",
  filter = "all",
  ascending = true,
  filtered = [],
  epoch = 0,
  active = 0,
  queue = [],
  mediaIndex = 0;
const jobs = new Map(),
  urls = new Map(),
  cancellations = new Set();
const size = (n) =>
  n < 1024
    ? n + " Б"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " КБ"
      : n < 1073741824
        ? (n / 1048576).toFixed(1) + " МБ"
        : (n / 1073741824).toFixed(2) + " ГБ";
const date = (n) =>
  n ? new Date(n).toLocaleDateString("ru-RU") : "Дата не указана";
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
}
async function history(items) {
  $("history").replaceChildren();
  for (const item of items) {
    const b = el("button", "", item.name);
    b.title = item.name + " · " + date(item.date);
    b.onclick = () => {
      $("link").value = item.url;
      return open(item.url, true);
    };
    $("history").append(b);
  }
}
async function open(link, atRoot = false) {
  $("open").disabled = true;
  message("Получаем каталог MEGA…");
  try {
    apply(await window.mega.open(link, atRoot));
    message("Коллекция открыта. Превью появляются при прокрутке.");
  } catch (e) {
    message(
      "Не удалось открыть: " +
        e.message.replace(/^Error invoking remote method.*?Error: /, ""),
      true,
    );
  } finally {
    $("open").disabled = false;
  }
}
function apply(data) {
  showSection("library");
  closeViewer();
  epoch++;
  for (const cancel of cancellations) cancel();
  queue = [];
  jobs.clear();
  urls.clear();
  $("grid").replaceChildren();
  all = data.nodes;
  base = data.base;
  byId = new Map(all.map((n) => [n.id, n]));
  children = new Map();
  for (const n of all) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  current = byId.has(data.initialId) ? data.initialId : all[0].id;
  filter = "all";
  $("search").value = "";
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
  history(data.history);
  refresh();
}
function navigateFolder(id) {
  if (!byId.has(id)) return;
  current = id;
  $("search").value = "";
  filter = "all";
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
  refresh();
}
function refresh() {
  const folder = byId.get(current);
  if (!folder) return;
  const query = $("search").value.trim().toLocaleLowerCase();
  let source =
    folder.type === "folder" ? children.get(current) || [] : [folder];
  if (query) {
    source = [];
    const stack = [...(children.get(current) || [])];
    if (folder.type !== "folder") stack.push(folder);
    while (stack.length) {
      const n = stack.pop();
      source.push(n);
      if (n.type === "folder") stack.push(...(children.get(n.id) || []));
    }
  }
  filtered = source.filter(
    (n) =>
      (filter === "all" || n.type === filter) &&
      (!query || n.name.toLocaleLowerCase().includes(query)),
  );
  const field = $("sort").value;
  filtered.sort((a, b) => {
    // Keep folders before files in both sort directions, as in a file browser.
    if ((a.type === "folder") !== (b.type === "folder"))
      return a.type === "folder" ? -1 : 1;
    let diff =
      field === "name" || field === "type"
        ? a[field].localeCompare(b[field], "ru", { numeric: true })
        : a[field] - b[field];
    return (
      (diff || a.name.localeCompare(b.name, "ru", { numeric: true })) *
      (ascending ? 1 : -1)
    );
  });
  $("folderTitle").textContent = folder.name;
  $("folderTitle").hidden = true;
  $("stats").textContent =
    `${filtered.length} объектов · ${size(filtered.reduce((s, n) => s + n.size, 0))}${query ? " · поиск во вложенных папках" : ""}`;
  $("crumbs").replaceChildren();
  let ancestors = [],
    p = folder;
  while (p) {
    ancestors.unshift(p);
    p = byId.get(p.parent);
  }
  for (const n of ancestors) {
    if ($("crumbs").children.length) {
      const separator = el("span", "crumb-separator", "›");
      separator.setAttribute("aria-hidden", "true");
      $("crumbs").append(separator);
    }
    const b = el("button", "", n.name);
    b.title = n.name;
    b.dataset.folderId = n.id;
    if (n.id === current) {
      b.setAttribute("aria-current", "page");
      b.disabled = true;
    }
    b.onclick = () => navigateFolder(n.id);
    $("crumbs").append(b);
  }
  $("viewport").scrollTop = 0;
  $("empty").hidden = filtered.length > 0;
  if (!filtered.length) {
    $("empty").replaceChildren(
      el("div", "empty-icon", "⌕"),
      el(
        "h2",
        "",
        query || filter !== "all" ? "Ничего не найдено" : "Папка пуста",
      ),
      el(
        "p",
        "",
        query || filter !== "all"
          ? "Попробуйте другой фильтр или поисковый запрос."
          : byId.has(folder.parent)
            ? "Нажмите на название родительской папки в пути сверху."
            : "В этой публичной папке пока нет файлов и вложенных папок.",
      ),
    );
  }
  render();
}
function render() {
  const viewport = $("viewport"),
    grid = $("grid");
  const columns = 6,
    gap = 12,
    width = (viewport.clientWidth - 8 - gap * (columns - 1)) / columns,
    rowHeight = 230;
  grid.style.height = Math.ceil(filtered.length / columns) * rowHeight + "px";
  const first =
      Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 1) * columns,
    last = Math.min(
      filtered.length,
      (Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) +
        1) *
        columns,
    );
  const retained = new Map(
    [...grid.children].map((card) => [card.dataset.id, card]),
  );
  const wanted = new Set(filtered.slice(first, last).map((n) => n.id));
  for (const [id, card] of retained) if (!wanted.has(id)) card.remove();
  for (let i = first; i < last; i++) {
    const n = filtered[i];
    const style = `left:${(i % columns) * (width + gap)}px;top:${Math.floor(i / columns) * rowHeight}px;width:${width}px;height:214px`;
    if (retained.has(n.id)) {
      retained.get(n.id).style.cssText = style;
      continue;
    }
    const card = el(
      "button",
      n.type === "folder" ? "card card-folder" : "card",
    );
    card.dataset.id = n.id;
    card.dataset.type = n.type;
    card.style.cssText = `left:${(i % columns) * (width + gap)}px;top:${Math.floor(i / columns) * rowHeight}px;width:${width}px;height:214px`;
    card.title = n.name;
    card.setAttribute("aria-label", n.name);
    card.oncontextmenu = (e) => {
      e.preventDefault();
      if (n.type !== "folder") window.mega.fileMenu(n.id, n.cache);
    };
    card.onclick = () => {
      if (n.type === "folder") {
        navigateFolder(n.id);
      } else if (["photo", "video"].includes(n.type)) showMedia(n.id);
      else message("Этот тип файла не поддерживает встроенный просмотр.", true);
    };
    const thumb = el("div", "thumb");
    thumb.dataset.node = n.id;
    const icon = el(
      "span",
      n.type === "folder" ? "folder-icon" : "placeholder",
      n.type === "folder" ? "" : n.type === "video" ? "▷" : "▧",
    );
    icon.setAttribute("aria-hidden", "true");
    thumb.append(icon);
    if (n.type === "photo" || n.type === "video") {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      if (urls.has(n.cache)) img.src = urls.get(n.cache);
      else {
        enqueue(n, thumb);
      }
      img.onerror = () => {
        img.remove();
        enqueue(n, thumb);
      };
      thumb.append(img);
    }
    if (n.type !== "folder")
      thumb.append(
        el(
          "span",
          "badge",
          n.type === "folder"
            ? "ПАПКА"
            : n.type === "video"
              ? "ВИДЕО"
              : n.type === "photo"
                ? "ФОТО"
                : "ФАЙЛ",
        ),
      );
    const body = el("div", "card-body");
    body.append(el("div", "name", n.name));
    const meta = el("div", "meta");
    meta.append(
      el(
        "span",
        "",
        n.type === "folder"
          ? (children.get(n.id) || []).length + " объектов"
          : size(n.size),
      ),
      el("span", "", date(n.date)),
    );
    body.append(meta);
    card.append(thumb, body);
    grid.append(card);
  }
  $("shown").textContent =
    `${filtered.length} объектов · ${Math.max(0, last - first)} плиток в памяти`;
}
function enqueue(n, host) {
  if (previewPaused) return;
  if (jobs.has(n.cache)) return;
  jobs.set(n.cache, true);
  queue.push({ n, host, version: epoch });
  queueMicrotask(pump);
}
function pump() {
  while (!previewPaused && active < 3 && queue.length) {
    const task = queue.shift();
    if (task.version !== epoch || !task.host.isConnected) {
      jobs.delete(task.n.cache);
      continue;
    }
    active++;
    loadThumb(task.n)
      .then(async (data) => {
        if (!data || task.version !== epoch) return;
        urls.set(task.n.cache, data);
        if (urls.size > 150) urls.delete(urls.keys().next().value);
        if (data.startsWith("data:"))
          await window.mega.putThumb(task.n.id, data, task.n.cache);
        const target = document.querySelector(`[data-node="${task.n.id}"]`);
        if (target) {
          const img = el("img");
          img.alt = "";
          img.src = data;
          target.prepend(img);
        }
      })
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}
async function loadThumb(n) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  cancellations.add(cancel);
  try {
    const response = await fetch(`${base}/thumb/${n.id}`, {
      signal: controller.signal,
    });
    if (response.ok) {
      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }
  } catch {
  } finally {
    cancellations.delete(cancel);
  }
  if (previewPaused || controller.signal.aborted) return null;
  return makeThumb(n);
}
function makeThumb(n) {
  return new Promise((resolve) => {
    if (n.type === "photo" && n.size > 32 * 1024 * 1024) {
      resolve(null);
      return;
    }
    const m = document.createElement(n.type === "video" ? "video" : "img");
    m.crossOrigin = "anonymous";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cancellations.delete(cancel);
      m.onload = m.onerror = m.onloadeddata = m.onseeked = null;
      m.removeAttribute("src");
      if (m.tagName === "VIDEO") m.load();
      resolve(result);
    };
    const cancel = () => finish(null);
    cancellations.add(cancel);
    const timer = setTimeout(cancel, 25000);
    const draw = () => {
      try {
        const w = m.videoWidth || m.naturalWidth,
          h = m.videoHeight || m.naturalHeight;
        if (!w || !h) return finish(null);
        const c = document.createElement("canvas");
        c.width = Math.min(640, w);
        c.height = Math.max(1, Math.round((c.width * h) / w));
        if (c.height > 1200) c.height = 1200;
        c.getContext("2d").drawImage(m, 0, 0, c.width, c.height);
        finish(c.toDataURL("image/jpeg", 0.92));
      } catch {
        finish(null);
      }
    };
    m.onerror = cancel;
    if (n.type === "video") {
      m.muted = true;
      m.preload = "auto";
      m.onloadeddata = draw;
    } else m.onload = draw;
    m.src = `${base}/media/${n.id}?preview=1`;
  });
}
function mediaList() {
  return filtered.filter((n) => ["photo", "video"].includes(n.type));
}
function showMedia(id, retry = false) {
  const list = mediaList();
  mediaIndex = list.findIndex((n) => n.id === id);
  const n = list[mediaIndex];
  if (!n) return;
  currentMediaId = id;
  if (!retry) {
    playerAttempt = 0;
    playerResume = 0;
  }
  previewPaused = true;
  window.mega.playback(true, id);
  epoch++;
  for (const cancel of cancellations) cancel();
  queue = [];
  jobs.clear();
  clearMedia();
  $("retryMedia").hidden = true;
  $("mediaTitle").textContent = n.name;
  $("mediaInfo").textContent = size(n.size) + " · " + date(n.date);
  $("mediaStatus").textContent = "Загрузка…";
  const m = el(n.type === "video" ? "video" : "img");
  m.src = `${base}/media/${n.id}`;
  if (n.type === "video") {
    m.controls = true;
    m.autoplay = true;
    m.preload = "auto";
    m.onwaiting = () => {
      $("mediaStatus").textContent = "Буферизация… загружаем видео";
    };
    m.onplaying = () => {
      clearTimeout(playerTimer);
      playerTimer = null;
      $("retryMedia").hidden = true;
      $("mediaStatus").textContent = "← → переключить · Esc закрыть";
    };
    m.onloadeddata = () =>
      ($("mediaStatus").textContent = "← → переключить · Esc закрыть");
    m.onloadedmetadata = () => {
      if (playerResume > 0 && playerResume < m.duration)
        m.currentTime = playerResume;
    };
    const arm = () => {
      if (playerTimer) return;
      playerTimer = setTimeout(async () => {
        playerTimer = null;
        if (!m.isConnected) return;
        const error = await window.mega.mediaError(id);
        if (!m.isConnected) return;
        if (!error && playerAttempt < 1) {
          playerAttempt++;
          playerResume = m.currentTime || playerResume;
          await window.mega.retryMedia(id);
          if (m.isConnected) showMedia(id, true);
        } else {
          $("retryMedia").hidden = false;
          $("mediaStatus").textContent = error
            ? `MEGA: ${error}`
            : "Видео долго не отвечает. Повторите загрузку или скачайте файл.";
        }
      }, 18000);
    };
    arm();
    m.onwaiting = () => {
      $("mediaStatus").textContent = "Буферизация…";
      arm();
    };
    m.onstalled = arm;
  } else {
    m.alt = n.name;
    m.onload = () =>
      ($("mediaStatus").textContent = "← → переключить · Esc закрыть");
  }
  m.onerror = async () => {
    clearTimeout(playerTimer);
    playerTimer = null;
    $("retryMedia").hidden = false;
    const error = await window.mega.mediaError(n.id);
    if (!m.isConnected) return;
    $("mediaStatus").textContent = error?.includes("EBLOCKED")
      ? "MEGA заблокировала доступ к этому файлу (EBLOCKED). Другие файлы папки могут быть доступны."
      : error
        ? `Ошибка MEGA: ${error}`
        : "Не удалось декодировать видео или фото. Проверьте формат и кодек (MP4 H.264 / WebM).";
  };
  $("media").append(m);
  $("prev").disabled = mediaIndex === 0;
  $("next").disabled = mediaIndex === list.length - 1;
  if (!$("viewer").open) $("viewer").showModal();
}
function clearMedia() {
  clearTimeout(playerTimer);
  playerTimer = null;
  const v = $("media").querySelector("video");
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  $("media").replaceChildren();
}
function closeViewer() {
  clearMedia();
  if ($("viewer").open) $("viewer").close();
  resumePreviews();
}
$("retryMedia").onclick = async () => {
  const id = currentMediaId;
  if (!id) return;
  playerResume = $("media").querySelector("video")?.currentTime || 0;
  playerAttempt = 1;
  await window.mega.retryMedia(id);
  showMedia(id, true);
};
$("downloadMedia").onclick = () => {
  const n = byId.get(currentMediaId);
  if (n)
    window.mega
      .downloadFile(n.id, n.cache)
      .catch((e) => message(e.message, true));
};
function showSection(section) {
  document.querySelector(".library").hidden = section !== "library";
  $("downloadsPanel").hidden = section !== "downloads";
  $("libraryNav").classList.toggle("nav-active", section === "library");
  $("downloadsNav").classList.toggle("nav-active", section === "downloads");
  if (section === "library" && all.length) requestAnimationFrame(render);
}
function renderDownloads(list) {
  downloadsState = list;
  const host = $("downloadsList");
  host.replaceChildren();
  $("downloadsBadge").textContent = list.filter((j) =>
    ["queued", "downloading", "paused"].includes(j.status),
  ).length;
  if (!list.length) {
    host.append(
      el(
        "p",
        "muted",
        "Нажмите правой кнопкой на файл в каталоге и выберите «Скачать файл…».",
      ),
    );
    return;
  }
  const labels = {
    queued: "В очереди",
    downloading: "Скачивание",
    paused: "Ожидает закрытия плеера",
    completed: "Готово",
    cancelled: "Отменено",
    error: "Ошибка",
    interrupted: "Прервано закрытием приложения",
  };
  for (const j of list) {
    const row = el("article", "download-row");
    row.dataset.downloadId = j.id;
    const info = el("div", "download-info");
    info.append(el("strong", "", j.name), el("small", "", j.path));
    const progress = el("progress");
    progress.max = j.size || 1;
    progress.value = j.loaded;
    info.append(progress);
    info.append(
      el(
        "span",
        "muted",
        `${labels[j.status] || j.status} · ${size(j.loaded)} / ${size(j.size)}${j.status === "downloading" ? " · " + size(j.speed) + "/с" : ""}${j.error ? " · " + j.error : ""}`,
      ),
    );
    const actions = el("div", "download-actions");
    const add = (label, action) => {
      const b = el("button", "quiet", label);
      b.onclick = () =>
        window.mega
          .downloadAction(action, j.id)
          .then(renderDownloads)
          .catch((e) => message(e.message, true));
      actions.append(b);
    };
    if (["queued", "downloading", "paused"].includes(j.status))
      add("Отменить", "cancel");
    if (["error", "cancelled"].includes(j.status)) add("Повторить", "retry");
    if (j.status === "completed") add("Показать в папке", "reveal");
    row.append(info, actions);
    host.append(row);
  }
}
$("downloadsNav").onclick = () => showSection("downloads");
$("libraryNav").onclick = $("backToLibrary").onclick = () =>
  showSection("library");
window.mega.onDownloads(renderDownloads);
window.mega.onShowDownloads(() => showSection("downloads"));
window.mega.downloads().then(renderDownloads);
function resumePreviews() {
  previewPaused = false;
  window.mega.playback(false);
  if (all.length) {
    $("grid").replaceChildren();
    render();
  }
}
for (const action of ["minimize", "maximize", "close"])
  $("window-" + action).onclick = () => window.mega.window(action);
$("linkForm").onsubmit = (e) => {
  e.preventDefault();
  open($("link").value);
};
$("search").oninput = refresh;
$("sort").onchange = refresh;
$("direction").onclick = () => {
  ascending = !ascending;
  $("direction").textContent = ascending ? "↑" : "↓";
  refresh();
};
document.querySelectorAll("[data-filter]").forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.filter;
      document
        .querySelectorAll("[data-filter]")
        .forEach((x) => x.classList.toggle("active", x === b));
      refresh();
    }),
);
let scheduled = false;
$("viewport").onscroll = () => {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  }
};
new ResizeObserver(() => {
  if (all.length) render();
}).observe($("viewport"));
$("close").onclick = closeViewer;
$("viewer").onclose = () => {
  if (!$("viewer").open) {
    clearMedia();
    if (previewPaused) resumePreviews();
  }
};
$("prev").onclick = () => showMedia(mediaList()[mediaIndex - 1]?.id);
$("next").onclick = () => showMedia(mediaList()[mediaIndex + 1]?.id);
$("fullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("viewer").requestFullscreen();
};
document.addEventListener("keydown", (e) => {
  if (!$("viewer").open || e.target.tagName === "VIDEO") return;
  if (e.key === "ArrowLeft") $("prev").click();
  if (e.key === "ArrowRight") $("next").click();
});
$("clearHistory").onclick = async () =>
  history(await window.mega.clearHistory());
$("clearCache").onclick = async () => {
  epoch++;
  for (const cancel of cancellations) cancel();
  queue = [];
  jobs.clear();
  urls.clear();
  await window.mega.clearCache();
  message("Кэш очищен. Новые превью сохранятся при просмотре.");
};
window.mega.history().then(history);
window.runSmoke = async () => {
  const bridge =
    Array.isArray(await window.mega.history()) &&
    Array.isArray(await window.mega.downloads());
  const initial = !$("empty").hidden && $("grid").children.length === 0;
  $("downloadsNav").click();
  const downloads =
    !$("downloadsPanel").hidden && document.querySelector(".library").hidden;
  $("libraryNav").click();
  const navigation =
    $("downloadsPanel").hidden && !document.querySelector(".library").hidden;
  const clean =
    !document.querySelector("#demo, #emptyDemo") && !("demo" in window.mega);
  const compact = $("viewport").getBoundingClientRect().top < 150;
  return {
    ok: bridge && initial && downloads && navigation && clean && compact,
    bridge,
    initial,
    downloads,
    navigation,
    clean,
    compact,
  };
};
window.runLiveTest = async (url, extended = false, videoIndex = 0) => {
  const data = await window.mega.open(url);
  apply(data);
  // Test actual media decoding without saving screenshots of user content.
  const results = { nodes: all.length, folder: all[0].type === "folder" };
  const initial = current;
  results.breadcrumbs = $("crumbs").querySelectorAll("button").length;
  if (byId.has(byId.get(current)?.parent)) {
    $("crumbs")
      .querySelector(`[data-folder-id="${byId.get(current).parent}"]`)
      .click();
    results.parentFolders = filtered.filter((n) => n.type === "folder").length;
    results.parentNavigation = !!document.querySelector(
      `.card-folder[data-id="${initial}"]`,
    );
    navigateFolder(initial);
  }
  results.serverThumbnails = all.filter((n) => n.serverThumb).length;
  results.highQualityPreviews = all.filter((n) => n.serverPreview).length;
  console.log("TEST catalogue " + JSON.stringify(results));
  const videoNode = filtered.filter(
    (n) => n.type === "video" && n.mime === "video/mp4",
  )[videoIndex];
  if (videoNode) {
    const started = performance.now();
    showMedia(videoNode.id);
    const v = $("media").querySelector("video");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 45000);
      v.onloadeddata = () => {
        clearTimeout(t);
        resolve();
      };
      v.onerror = () => {
        clearTimeout(t);
        resolve();
      };
    });
    results.video = v.videoWidth > 0;
    results.startupMs = Math.round(performance.now() - started);
    results.videoError = v.error?.code || null;
    const actual = $("media").querySelector("video");
    results.playerState = {
      connected: v.isConnected,
      ready: actual?.readyState,
      network: actual?.networkState,
      width: actual?.videoWidth,
      time: actual?.currentTime,
      status: $("mediaStatus").textContent,
    };
    console.log(
      "TEST first video " +
        JSON.stringify({ loaded: results.video, ms: results.startupMs }),
    );
    if (extended && results.video) {
      const initial = v.currentTime;
      let stalls = 0;
      v.addEventListener("waiting", () => stalls++);
      await new Promise((r) => setTimeout(r, 20000));
      results.playedSeconds = Math.round((v.currentTime - initial) * 10) / 10;
      results.stalls = stalls;
      const target = Math.min(v.duration / 2, 60);
      const sought = new Promise((r) => {
        const timer = setTimeout(() => r(false), 15000);
        v.addEventListener(
          "seeked",
          () => {
            clearTimeout(timer);
            r(true);
          },
          { once: true },
        );
      });
      v.currentTime = target;
      results.seekDecoded = await sought;
      results.previewPaused = previewPaused && active === 0;
    }
    closeViewer();
    console.log("TEST range start");
    const response = await fetch(`${base}/media/${videoNode.id}`, {
      headers: { Range: "bytes=32-95" },
    });
    results.range =
      response.status === 206 &&
      (await response.arrayBuffer()).byteLength === 64;
    const preview = await makeThumb(videoNode);
    console.log(
      "TEST range and frame " +
        JSON.stringify({ range: results.range, frame: !!preview }),
    );
    results.videoPreview = !!preview;
    if (preview) {
      await window.mega.putThumb(videoNode.id, preview, videoNode.cache);
      results.cache = (await fetch(`${base}/thumb/${videoNode.id}`)).ok;
    }
  }
  const photoNode = filtered.find((n) => n.type === "photo");
  if (photoNode) {
    const preview = await makeThumb(photoNode);
    results.photo = !!preview;
    if (!preview)
      results.photoError = await window.mega.mediaError(photoNode.id);
    if (preview) {
      await window.mega.putThumb(photoNode.id, preview, photoNode.cache);
      results.cache = (await fetch(`${base}/thumb/${photoNode.id}`)).ok;
    }
  }
  results.ok =
    results.folder &&
    results.video &&
    results.range &&
    results.videoPreview &&
    results.cache &&
    (results.photo || results.photoError?.includes("EBLOCKED"));
  if (extended)
    results.ok =
      results.ok &&
      results.playedSeconds >= 15 &&
      results.seekDecoded &&
      results.previewPaused;
  if (extended) {
    results.additionalVideos = [];
    const videos = filtered.filter((n) => n.mime === "video/mp4");
    for (const index of [5, 30, 80]) {
      if (!videos[index]) continue;
      const n = videos[index],
        started = performance.now();
      showMedia(n.id);
      const v = $("media").querySelector("video");
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 35000);
        const finish = (ok) => {
          clearTimeout(timer);
          resolve(ok);
        };
        v.addEventListener("loadeddata", () => finish(true), { once: true });
        v.addEventListener("error", () => finish(false), { once: true });
      });
      results.additionalVideos.push({
        index,
        loaded,
        ms: Math.round(performance.now() - started),
        error: await window.mega.mediaError(n.id),
      });
      closeViewer();
      console.log(
        "TEST additional " + JSON.stringify(results.additionalVideos.at(-1)),
      );
    }
    results.ok = results.ok && results.additionalVideos.every((r) => r.loaded);
    const hq = all.find((n) => n.serverPreview && n.type === "video");
    if (hq) {
      const response = await fetch(`${base}/thumb/${hq.id}`);
      if (response.ok) {
        const bitmap = await createImageBitmap(await response.blob());
        results.previewResolution = [bitmap.width, bitmap.height];
        bitmap.close();
      }
    }
  }
  await $("history").querySelector("button").onclick();
  results.recentRoot =
    current === all[0].id && !$("message").classList.contains("error");
  results.recentFolders = filtered.filter((n) => n.type === "folder").length;
  results.ok =
    results.ok && results.recentRoot && results.parentNavigation !== false;
  return results;
};
