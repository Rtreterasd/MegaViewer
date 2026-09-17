const { test } = require("node:test");
const assert = require("node:assert/strict");
const { range, validateLink, describe } = require("../src/core.cjs");
const { parseLink } = require("../src/core.cjs");
const { File } = require("megajs");
test("nested folder and file fragments keep node handle out of encryption key", () => {
  for (const type of ["folder", "file"]) {
    const parsed = parseLink(
      `https://mega.nz/folder/abcdefgh#AAAAAAAAAAAAAAAAAAAAAA/${type}/ijklmnop`,
    );
    const f = File.fromURL(parsed.url, { loadedFile: parsed.selectedId });
    assert.equal(f.loadedFile, "ijklmnop");
    assert.equal(f.key.length, 16);
    assert.equal(f.directory, true);
  }
  assert.equal(
    parseLink("https://www.mega.nz/folder/abcdefgh/#AAAAAAAAAAAAAAAAAAAAAA")
      .url,
    "https://mega.nz/folder/abcdefgh#AAAAAAAAAAAAAAAAAAAAAA",
  );
});
test("ranges support seeking, suffix and open end", () => {
  assert.deepEqual(range("bytes=20-39", 100), {
    start: 20,
    end: 39,
    partial: true,
  });
  assert.deepEqual(range("bytes=-10", 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  assert.equal(range("bytes=20-", 100).end, 99);
  assert.equal(range("bytes=20-999", 100).end, 99);
  assert.equal(range(undefined, 100).partial, false);
});
test("invalid and unsatisfiable ranges are rejected", () => {
  for (const h of [
    "bytes=100-",
    "bytes=5-2",
    "bytes=0-1,4-5",
    "bytes=-",
    "bytes=-0",
    "invalid",
  ])
    assert.throws(() => range(h, 100));
});
test("only MEGA HTTPS public links accepted", () => {
  assert.match(
    validateLink("https://mega.nz/folder/abcdefgh#abcdefghijklmnopqrstuv"),
    /^https:/,
  );
  for (const u of [
    "file:///etc/passwd",
    "https://evil.example/file/1#key",
    "https://mega.nz.evil.example/#key",
    "http://mega.nz/#key",
    "https://mega.nz/file/abc",
  ])
    assert.throws(() => validateLink(u));
});
test("metadata classifies supported media and missing dates", () => {
  assert.equal(
    describe({ name: "Clip.MP4", size: 42 }, "1", null).type,
    "video",
  );
  assert.equal(describe({ name: "a.jpeg" }, "2", null).type, "photo");
  assert.equal(
    describe({ name: "p", directory: true }, "3", null).type,
    "folder",
  );
  assert.equal(describe({ name: "a.exe" }, "4", null).type, "other");
  assert.equal(describe({ name: "a" }, "5", null).date, 0);
});
