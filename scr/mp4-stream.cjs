const { Transform } = require("node:stream");
// Some non-fragmented MP4s contain hundreds of separate mdat boxes. Chromium
// probes each box before playback. A virtual size=0 on the first mdat makes
// them one data region, while stco/co64 offsets and every sample byte stay put.
// Only use this for an early complete moov, no mvex, and two adjacent mdats.
async function mp4Patch(item, cache) {
  if (item.meta.mime !== "video/mp4") return null;
  const read = async (start, end) => {
    const chunks = [];
    for await (const b of cache.range(item, start, end)) chunks.push(b);
    return Buffer.concat(chunks);
  };
  let pos = 0,
    sawMoov = false;
  for (
    let boxes = 0;
    boxes < 12 && pos + 8 < item.meta.size && pos < 4 * 1024 * 1024;
    boxes++
  ) {
    const head = await read(pos, pos + 7);
    if (head.length !== 8) return null;
    const length = head.readUInt32BE(0),
      type = head.toString("ascii", 4, 8);
    if (length < 8 || pos + length > item.meta.size) return null;
    if (pos === 0 && type !== "ftyp") return null;
    if (type === "moof") return null;
    if (type === "moov") {
      if (length > 4 * 1024 * 1024) return null;
      const moov = await read(pos, pos + length - 1);
      if (moov.includes(Buffer.from("mvex"))) return null;
      sawMoov = true;
    }
    if (type === "mdat") {
      if (!sawMoov || pos + length + 8 > item.meta.size) return null;
      const next = await read(pos + length, pos + length + 7);
      if (
        next.toString("ascii", 4, 8) !== "mdat" ||
        next.readUInt32BE(0) < 8 ||
        pos + length + next.readUInt32BE(0) > item.meta.size
      )
        return null;
      return { offset: pos };
    }
    pos += length;
  }
  return null;
}
function patchRange(source, start, patch) {
  if (!patch) return source;
  let offset = start;
  const output = new Transform({
    transform(chunk, _, callback) {
      const from = Math.max(0, patch.offset - offset),
        to = Math.min(chunk.length, patch.offset + 4 - offset);
      if (to > from) {
        chunk = Buffer.from(chunk);
        chunk.fill(0, from, to);
      }
      offset += chunk.length;
      callback(null, chunk);
    },
  });
  source.on("error", (e) => output.destroy(e));
  output.once("close", () => source.destroy());
  source.pipe(output);
  return output;
}
module.exports = { mp4Patch, patchRange };
