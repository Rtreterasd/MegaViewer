const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { Readable } = require("node:stream");
const { Downloads, safeName } = require("../src/downloads.cjs");
test("download is complete before publication, saved history has no source secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-download-test-"));
  const manager = new Downloads({
    historyFile: path.join(root, "history.json"),
  });
  const data = Buffer.from("verified-content");
  const item = {
    meta: { name: "test.txt", size: data.length },
    file: { secret: "DO-NOT-SAVE", download: () => Readable.from([data]) },
  };
  const output = path.join(root, "test.txt");
  manager.add(item, output);
  await manager.active.done;
  assert.equal(manager.jobs[0].status, "completed");
  assert.deepEqual(await fs.readFile(output), data);
  assert.equal(
    (await fs.readFile(manager.historyFile, "utf8")).includes("DO-NOT-SAVE"),
    false,
  );
  const restored = new Downloads({ historyFile: manager.historyFile });
  await restored.init();
  assert.equal(restored.jobs[0].status, "completed");
  await manager.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
test("failure and cancellation do not overwrite an existing destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-download-test-")),
    dest = path.join(root, "a.txt");
  await fs.writeFile(dest, "original");
  const manager = new Downloads({
    historyFile: path.join(root, "history.json"),
  });
  manager.add(
    {
      meta: { name: "a", size: 20 },
      file: { download: () => Readable.from([Buffer.from("short")]) },
    },
    dest,
  );
  await manager.active.done;
  assert.equal(manager.jobs[0].status, "error");
  assert.equal(await fs.readFile(dest, "utf8"), "original");
  manager.setPlaying(true);
  const id = manager.add(
    {
      meta: { name: "b", size: 1 },
      file: {
        download: () => {
          throw Error("must not start");
        },
      },
    },
    path.join(root, "b"),
  );
  manager.cancel(id);
  manager.setPlaying(false);
  assert.equal(manager.jobs.find((j) => j.id === id).status, "cancelled");
  assert.equal(
    (await fs.readdir(root)).some((n) => n.endsWith(".part")),
    false,
  );
  await manager.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
test("active cancellation removes partial file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-download-test-"));
  const manager = new Downloads({
    historyFile: path.join(root, "history.json"),
  });
  let source;
  const id = manager.add(
    {
      meta: { name: "a", size: 1000 },
      file: {
        download: () => {
          source = new Readable({ read() {} });
          source.push(Buffer.alloc(5));
          return source;
        },
      },
    },
    path.join(root, "a"),
  );
  await new Promise((r) => setTimeout(r, 30));
  const done = manager.active.done;
  manager.cancel(id);
  await done;
  assert.equal(manager.jobs[0].status, "cancelled");
  assert.equal(
    (await fs.readdir(root)).some((n) => n.endsWith(".part")),
    false,
  );
  await manager.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
test("unsafe Windows names are normalized", () => {
  assert.equal(safeName("../../x.txt"), "x.txt");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(safeName("a:b?.txt"), "a_b_.txt");
});
