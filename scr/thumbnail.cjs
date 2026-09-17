const crypto = require("node:crypto");
// MEGA file attributes: ufa r=1 -> [8-byte handle, 4-byte LE length, AES-CBC data].
// Protocol reference: meganz/webclient js/crypto.js, GetFA / api_getfileattr.
async function serverThumbnail(file, fa, signal, type = 0) {
  const match = new RegExp("(?:^|/)(\\d+):" + type + "\\*([\\w-]+)").exec(
    fa || "",
  );
  if (!match) return null;
  const handle = Buffer.from(match[2], "base64url");
  const info = await file.api.request({
    a: "ufa",
    fah: match[2],
    r: 1,
    ssl: 2,
  });
  if (!info.p) throw Error("MEGA: нет сервера превью");
  const url = new URL(info.p + "/" + type);
  if (url.protocol !== "https:") throw Error("MEGA: требуется HTTPS");
  const response = await fetch(url, { method: "POST", body: handle, signal });
  if (!response.ok) throw Error("MEGA: превью недоступно " + response.status);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length < 12 || !raw.subarray(0, 8).equals(handle))
    throw Error("MEGA: повреждённое превью");
  const length = raw.readUInt32LE(8);
  if (!length || length % 16 || length + 12 > raw.length)
    throw Error("MEGA: неверный размер превью");
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) key[i] = file.key[i] ^ file.key[i + 16];
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16),
  );
  decipher.setAutoPadding(false);
  return Buffer.concat([
    decipher.update(raw.subarray(12, 12 + length)),
    decipher.final(),
  ]);
}
module.exports = { serverThumbnail };
