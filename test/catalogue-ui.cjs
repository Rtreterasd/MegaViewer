// Real Electron window and IPC, with catalogue metadata injected only by this
// test entry point. No sample collection or test media ships in the application.
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const profile = require("node:fs").mkdtempSync(
  path.join(os.tmpdir(), "mega-viewer-ui-"),
);
app.setPath("userData", profile);

// Keep the production link parser, IPC and history persistence in this test.
// Only replace MEGA's response for a reserved synthetic handle.
const { File } = require("megajs");
const originalFromURL = File.fromURL;
File.fromURL = function (input, options) {
  const file = originalFromURL.call(this, input, options);
  if (file.downloadId !== "testhist") return file;
  file.loadAttributes = async () => {
    file.nodeId = "testhist";
    file.name = "Проверка истории";
    file.children = [
      { nodeId: "histnode", name: "Альбом", directory: true, children: [] },
      {
        nodeId: "sibling0",
        name: "Вторая папка",
        directory: true,
        children: [],
      },
    ];
    if (file.loadedFile) {
      const selected = file.children.find((n) => n.nodeId === file.loadedFile);
      if (!selected) throw Error("Selected folder no longer exists");
      return selected;
    }
    return file;
  };
  return file;
};

async function exerciseCatalogue() {
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  check("startup and IPC", (await window.runSmoke()).ok);
  // Thumbnail networking is outside the navigation regression test.
  loadThumb = async () => null;
  const node = (id, parent, name, type = "folder", size = 0) => ({
    id,
    parent,
    name,
    type,
    size,
    date: 1789603200000,
    cache: id,
  });
  const catalogue = [
    node("root", null, "Медиатека"),
    node("photos", "root", "Фото"),
    node("videos", "root", "Видео"),
    node("archive", "root", "Архив"),
    node("notes", "root", "Заметки.md", "other", 1840),
    node("about", "root", "Описание.txt", "other", 2530),
    node("list", "root", "Список файлов.csv", "other", 8170),
    node("trip", "photos", "Поездка"),
    node("picture", "photos", "Горы.jpg", "photo", 250000),
    node("clip", "videos", "Пейзаж.mp4", "video", 900000),
    node("nested", "trip", "Кадр.jpg", "photo", 150000),
  ];
  const applyNodes = (nodes) => apply({ nodes, history: [], base: "" });
  const card = (id) => document.querySelector(`#grid [data-id="${id}"]`);
  const ids = () => filtered.map((n) => n.id);
  const selectFilter = (name) =>
    document.querySelector(`[data-filter="${name}"]`).click();
  const parentCrumb = () =>
    $("crumbs").querySelector(`[data-folder-id="${byId.get(current).parent}"]`);
  const search = (query) => {
    $("search").value = query;
    $("search").dispatchEvent(new Event("input"));
  };
  applyNodes(catalogue);
  check(
    "folders and files appear together",
    ids().length === 6 && !!card("photos") && !!card("about"),
  );
  check("no sidebar folder tree", !document.querySelector("aside nav, #tree"));
  check(
    "yellow folder tiles",
    document.querySelectorAll(".card-folder .folder-icon").length === 3,
  );
  check("back arrow removed", !$("folderUp"));
  check(
    "root breadcrumb is current",
    $("crumbs").querySelector('button[aria-current="page"]')?.dataset
      .folderId === "root",
  );
  apply({ nodes: catalogue, history: [], base: "", initialId: "trip" });
  check(
    "nested link selects requested folder",
    current === "trip" && ids().join() === "nested",
  );
  parentCrumb().click();
  check("nested link can open parent", current === "photos" && !!card("trip"));
  $("crumbs").querySelector('[data-folder-id="root"]').click();
  check(
    "nested link can reach sibling folders",
    !!card("videos") && !!card("archive"),
  );
  for (const field of ["name", "date", "size", "type"]) {
    $("sort").value = field;
    $("sort").dispatchEvent(new Event("change"));
    for (let i = 0; i < 2; i++) {
      $("direction").click();
      check(
        `folders first: ${field}, ${i}`,
        filtered.slice(0, 3).every((n) => n.type === "folder") &&
          filtered.slice(3).every((n) => n.type !== "folder"),
      );
    }
  }
  selectFilter("folder");
  check("folders filter", ids().length === 3);
  card("photos").click();
  check(
    "opening folder resets filter to all",
    filter === "all" && ids().includes("picture"),
  );
  card("trip").click();
  check(
    "nested folder and breadcrumb",
    ids().join() === "nested" &&
      $("crumbs").querySelectorAll("button").length === 3,
  );
  parentCrumb().click();
  check(
    "parent name opens parent",
    current === "photos" && ids().includes("trip"),
  );
  selectFilter("photo");
  check("photo filter", ids().join() === "picture");
  $("crumbs").querySelector('[data-folder-id="root"]').click();
  check("breadcrumb returns to root", current === "root" && filter === "all");
  card("videos").click();
  selectFilter("video");
  check("video filter", ids().join() === "clip");
  parentCrumb().click();
  search("Поездка");
  check("recursive search finds folders", ids().join() === "trip");
  card("trip").click();
  check(
    "opening search result clears query",
    $("search").value === "" && ids().join() === "nested",
  );
  $("crumbs").querySelector('[data-folder-id="root"]').click();
  card("archive").click();
  check(
    "empty folder remains navigable",
    !$("empty").hidden && !!parentCrumb(),
  );
  parentCrumb().click();
  $("downloadsNav").click();
  $("libraryNav").click();
  check("downloads round trip", current === "root" && !!card("photos"));
  applyNodes([node("single", null, "Один файл.txt", "other", 100)]);
  check(
    "single-file link",
    ids().join() === "single" &&
      $("crumbs").querySelectorAll("button").length === 1,
  );
  const many = [node("large", null, "Большая папка")];
  for (let i = 0; i < 1000; i++)
    many.push(node(`item${i}`, "large", `Папка ${String(i).padStart(4, "0")}`));
  applyNodes(many);
  check(
    "large folder virtualized",
    filtered.length === 1000 && $("grid").children.length < 60,
  );
  $("viewport").scrollTop = $("viewport").scrollHeight;
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  check(
    "last folder reachable by scrolling",
    !!card("item999") && $("grid").children.length < 60,
  );
  card("item999").click();
  parentCrumb().click();
  check(
    "parent name returns from virtualized folder",
    current === "large" && $("viewport").scrollTop === 0,
  );
  const nestedLink =
    "https://mega.nz/folder/testhist#AAAAAAAAAAAAAAAAAAAAAA/folder/histnode";
  await open(nestedLink);
  check(
    "pasted link opens selected folder through IPC",
    byId.get(current).name === "Альбом",
  );
  search("не найдено");
  selectFilter("video");
  $("downloadsNav").click();
  await $("history").querySelector("button").onclick();
  check(
    "recent link opens shared root through IPC",
    current === all[0].id &&
      filtered.filter((n) => n.type === "folder").length === 2,
  );
  check(
    "recent link restores catalogue and all files",
    !document.querySelector(".library").hidden &&
      filter === "all" &&
      $("search").value === "",
  );
  check(
    "recent root has one breadcrumb",
    $("crumbs").querySelectorAll("button").length === 1,
  );
  // Old history entries can still refer to a folder that has since disappeared.
  for (const url of [
    "https://mega.nz/folder/testhist#AAAAAAAAAAAAAAAAAAAAAA/folder/missing0",
    "https://mega.nz/folder/testhist#AAAAAAAAAAAAAAAAAAAAAA/file/missing0",
    "https://mega.nz/#F!testhist!AAAAAAAAAAAAAAAAAAAAAA!missing0",
  ]) {
    await history([{ url, name: "Старая ссылка", date: 0 }]);
    await $("history").querySelector("button").onclick();
    check(
      `old recent opens root: ${url.includes("#F!") ? "legacy" : url.includes("/file/") ? "file" : "folder"}`,
      !$("message").classList.contains("error") &&
        current === all[0].id &&
        filtered.length === 2,
    );
  }
  $("sort").value = "name";
  $("link").value = "";
  apply({
    nodes: [
      node("collections", null, "Мои коллекции"),
      ...catalogue.map((n) =>
        n.id === "root" ? { ...n, parent: "collections" } : n,
      ),
    ],
    initialId: "root",
    history: [],
    base: "",
  });
  const tiles = [...$("grid").children];
  check(
    "six columns",
    tiles.length === 6 && new Set(tiles.map((n) => n.offsetTop)).size === 1,
  );
  check("compact toolbar", $("viewport").getBoundingClientRect().top < 150);
  return { ok: true, checks };
}

app.once("browser-window-created", (_, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      const result = await win.webContents.executeJavaScript(
        `(${exerciseCatalogue.toString()})()`,
      );
      win.setSize(920, 620);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const smallLayout = await win.webContents.executeJavaScript(`
        document.documentElement.scrollWidth <= innerWidth &&
        document.getElementById("viewport").getBoundingClientRect().top < 150 &&
        document.getElementById("crumbs").clientWidth > 100
      `);
      if (!smallLayout) throw new Error("layout at minimum window size");
      result.checks.push("layout at minimum window size");
      win.setSize(1440, 760);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const screenshot = process.argv.includes("--screenshot-docs")
        ? path.join(__dirname, "../docs/screenshot.png")
        : path.join(os.tmpdir(), "mega-viewer-catalogue.png");
      await fs.mkdir(path.dirname(screenshot), { recursive: true });
      await fs.writeFile(
        screenshot,
        (await win.webContents.capturePage()).toPNG(),
      );
      console.log("CATALOGUE_UI", JSON.stringify(result));
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
});
require("../src/main.cjs");
