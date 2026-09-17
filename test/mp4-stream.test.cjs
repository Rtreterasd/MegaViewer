const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { mp4Patch, patchRange } = require("../src/mp4-stream.cjs");
const box = (tag, body = Buffer.alloc(8)) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(tag, 4);
  return Buffer.concat([header, body]);
};
function fixture(data) {
  return {
    item: { meta: { mime: "video/mp4", size: data.length } },
    cache: {
      range: (_, start, end) => Readable.from([data.subarray(start, end + 1)]),
    },
  };
}
test("multi-mdat MP4 optimization preserves size and sample offsets", async () => {
  const data = Buffer.concat([
    box("ftyp"),
    box("moov"),
    box("mdat", Buffer.from("abcdefgh")),
    box("mdat", Buffer.from("ijklmnop")),
  ]);
  const { item, cache } = fixture(data),
    patch = await mp4Patch(item, cache);
  assert.equal(patch.offset, 32);
  const chunks = [];
  for await (const b of patchRange(
    Readable.from([data.subarray(0, 34), data.subarray(34)]),
    0,
    patch,
  ))
    chunks.push(b);
  const actual = Buffer.concat(chunks);
  assert.equal(actual.length, data.length);
  assert.equal(actual.readUInt32BE(32), 0);
  assert.deepEqual(actual.subarray(36), data.subarray(36));
  const range = [];
  for await (const b of patchRange(
    Readable.from([data.subarray(34, 43)]),
    34,
    patch,
  ))
    range.push(b);
  assert.deepEqual(Buffer.concat(range), actual.subarray(34, 43));
});
test("single mdat, fragmented MP4 and late moov are left unchanged", async () => {
  for (const data of [
    Buffer.concat([box("ftyp"), box("moov"), box("mdat")]),
    Buffer.concat([
      box("ftyp"),
      box("moov", box("mvex")),
      box("mdat"),
      box("mdat"),
    ]),
    Buffer.concat([box("ftyp"), box("mdat"), box("moov")]),
  ]) {
    const { item, cache } = fixture(data);
    assert.equal(await mp4Patch(item, cache), null);
  }
});
