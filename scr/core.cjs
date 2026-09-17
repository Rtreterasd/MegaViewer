const path = require("node:path");
const TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};
function describe(file, id, parent) {
  const ext = path
    .extname(file.name || "")
    .slice(1)
    .toLowerCase();
  const mime = TYPES[ext] || "application/octet-stream";
  return {
    id,
    parent,
    name: file.name || "Без названия",
    size: file.size || 0,
    date: (file.timestamp || 0) * 1000,
    type: file.directory
      ? "folder"
      : mime.startsWith("image/")
        ? "photo"
        : mime.startsWith("video/")
          ? "video"
          : "other",
    mime,
  };
}
function validateLink(input) {
  if (typeof input !== "string" || input.length > 2048)
    throw Error("Некорректная ссылка");
  const u = new URL(input.trim());
  if (
    u.protocol !== "https:" ||
    !["mega.nz", "mega.co.nz", "www.mega.nz"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("Вставьте публичную HTTPS-ссылку MEGA.nz");
  if (!u.hash) throw Error("Нужна полная ссылка с ключом после #");
  return u.href;
}
// MEGAJS 1.x only splits /file/ in fragments; /folder/ needs the same
// loadedFile option (the SDK resolves either kind of node by its handle).
function parseLink(input) {
  const url = new URL(validateLink(input));
  if (url.hostname === "www.mega.nz") url.hostname = "mega.nz";
  const match = /^#([\w-]+)\/(file|folder)\/([\w-]+)\/?$/.exec(url.hash);
  let selectedId;
  if (match && /^\/folder\/[\w-]+\/?$/.test(url.pathname)) {
    url.hash = match[1];
    selectedId = match[3];
  }
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return { url: url.href, selectedId };
}
function range(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw Error("range");
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw Error("range");
  return { start, end, partial: true };
}
module.exports = { describe, validateLink, parseLink, range };
