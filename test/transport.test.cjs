const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { megaFetch } = require("../src/transport.cjs");
test("Node streaming adapter handles download cancellation", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(1024));
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 10);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const controller = new AbortController();
    const response = await megaFetch(
      `http://127.0.0.1:${server.address().port}`,
      { signal: controller.signal },
    );
    const destination = new PassThrough();
    destination.on("error", () => {});
    const closed = new Promise((r) => destination.once("close", r));
    destination.once("data", () => controller.abort());
    response.body.pipe(destination);
    destination.resume();
    await closed;
    assert.equal(destination.destroyed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
