const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { cacheDownloadUrl } = require("../src/download-url.cjs");
test("download ticket is reused across concurrent ranges and invalidated for retry", async () => {
  let requests = 0;
  const file = {
    api: {
      request: async () => {
        requests++;
        return { g: "https://example.test", s: 100 };
      },
    },
  };
  cacheDownloadUrl(file);
  const [a, b] = await Promise.all([
    file.api.request({ a: "g", g: 1 }),
    file.api.request({ a: "g", g: 1 }),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  file.invalidateDownloadUrl();
  await file.api.request({ a: "g", g: 1 });
  assert.equal(requests, 2);
});
