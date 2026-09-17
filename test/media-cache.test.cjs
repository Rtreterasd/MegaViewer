const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { MediaCache } = require("../src/media-cache.cjs");
test("first bytes arrive before a block has finished downloading", async () => {
  let finish;
  const source = new Readable({ read() {} });
  const cache = new MediaCache({ chunkSize: 16, parallel: 1 });
  const item = {
    meta: { cache: "progressive", size: 16 },
    file: { download: () => source },
  };
  const range = cache.range(item, 0, 15),
    iterator = range[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise((r) => setImmediate(r));
  source.push(Buffer.alloc(4, 1));
  const result = await Promise.race([
    first,
    new Promise((_, reject) => {
      finish = setTimeout(() => reject(Error("No progressive output")), 1000);
    }),
  ]);
  clearTimeout(finish);
  assert.equal(result.value.length, 4);
  source.push(Buffer.alloc(12, 2));
  source.push(null);
  const tail = [];
  for await (const b of { [Symbol.asyncIterator]: () => iterator })
    tail.push(b);
  assert.equal(Buffer.concat(tail).length, 12);
  cache.clear();
});
test("a failed block resumes at the first missing byte without duplicating data", async () => {
  let attempt = 0;
  const data = Buffer.from("0123456789abcdef");
  const item = {
    meta: { cache: "retry", size: 16 },
    file: {
      download: ({ start, end }) => {
        if (attempt++ === 0)
          return Readable.from(
            (async function* () {
              yield data.subarray(0, 4);
              throw Error("connection reset");
            })(),
          );
        return Readable.from([data.subarray(start, end + 1)]);
      },
    },
  };
  const cache = new MediaCache({ chunkSize: 16, parallel: 1 });
  const chunks = [];
  for await (const b of cache.range(item, 0, 15)) chunks.push(b);
  assert.deepEqual(Buffer.concat(chunks), data);
  assert.equal(attempt, 2);
  cache.clear();
});
test("overlapping ranges reuse chunks and return exact bytes", async () => {
  const data = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  let reads = 0;
  const item = {
    meta: { cache: "fixture", size: data.length },
    file: {
      download: ({ start, end }) => {
        reads++;
        return Readable.from([data.subarray(start, end + 1)]);
      },
    },
  };
  const cache = new MediaCache({ chunkSize: 16, maxBytes: 1024, parallel: 3 });
  const collect = async (stream) => {
    const chunks = [];
    for await (const b of stream) chunks.push(b);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(
    await collect(cache.range(item, 7, 80)),
    data.subarray(7, 81),
  );
  const count = reads;
  assert.deepEqual(
    await collect(cache.range(item, 20, 50)),
    data.subarray(20, 51),
  );
  assert.equal(reads, count);
  assert.deepEqual(await collect(cache.range(item, 99, 99)), data.subarray(99));
  cache.clear();
  assert.equal(cache.bytes, 0);
});
test("chunk cache evicts old bytes to its budget", async () => {
  const item = {
    meta: { cache: "f", size: 48 },
    file: {
      download: ({ start, end }) =>
        Readable.from([Buffer.alloc(end - start + 1)]),
    },
  };
  const cache = new MediaCache({ chunkSize: 16, maxBytes: 32 });
  for (let i = 0; i < 3; i++) await cache.chunk(item, i);
  assert.equal(cache.bytes, 32);
  assert.equal(cache.cache.size, 2);
  cache.clear();
});
