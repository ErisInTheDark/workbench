/* No production exports. Tests protect cross-wrapper atomic mutation serialization. Keywords: atomic json, reload, queue, lost update, test. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import AtomicJsonStore from "./AtomicJsonStore";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("a directory barrier waits for its own writes without waiting for a sibling owner", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-atomic-json-owner-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "transcripts");
  const file = path.join(directory, "state.json");
  const store = new AtomicJsonStore();
  await store.write(file, { count: 0 });
  const ownEntered = deferred();
  const otherEntered = deferred();
  const releaseOwn = deferred();
  const releaseOther = deferred();
  const own = store.update(file, { count: 0 }, async () => {
    ownEntered.resolve();
    await releaseOwn.promise;
    return { count: 1 };
  });
  const other = new AtomicJsonStore().update(path.join(root, "transcripts-other", "state.json"), {}, async () => {
    otherEntered.resolve();
    await releaseOther.promise;
    return {};
  });
  await Promise.all([ownEntered.promise, otherEntered.promise]);
  let drained = false;
  const drain = store.waitForIdle(directory).then(() => { drained = true; });
  try {
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { count: 0 });
    assert.equal(drained, false);
    releaseOwn.resolve();
    await own;
    assert.deepEqual(await store.read(file, {}), { count: 1 });
    assert.equal(drained, true);
  } finally {
    releaseOwn.resolve();
    releaseOther.resolve();
    await Promise.all([own, other, drain]);
  }
});

test("fresh wrappers serialize updates to one file without losing either write", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-atomic-json-reload-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const filePath = path.join(root, "state.json");
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const first = new AtomicJsonStore();
  const second = new AtomicJsonStore();

  const firstUpdate = first.update(filePath, { count: 0 }, async (current) => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return { count: current.count + 1 };
  });
  await firstEntered.promise;
  const secondUpdate = second.update(filePath, { count: 0 }, (current) => ({ count: current.count + 1 }));
  releaseFirst.resolve();
  await Promise.all([firstUpdate, secondUpdate]);

  assert.deepEqual(await first.read(filePath, { count: 0 }), { count: 2 });
});

test("fresh wrappers preserve update then direct-write ordering for one file", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-atomic-json-write-order-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const filePath = path.join(root, "state.json");
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const first = new AtomicJsonStore();
  const second = new AtomicJsonStore();

  const firstUpdate = first.update(filePath, { count: 0 }, async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return { count: 1 };
  });
  await firstEntered.promise;
  const secondWrite = second.write(filePath, { count: 2 });
  releaseFirst.resolve();
  await Promise.all([firstUpdate, secondWrite]);

  assert.deepEqual(await first.read(filePath, { count: 0 }), { count: 2 });
});

test("a fresh wrapper read waits for a prior wrapper mutation", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-atomic-json-read-order-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const filePath = path.join(root, "state.json");
  const mutationEntered = deferred();
  const releaseMutation = deferred();
  const first = new AtomicJsonStore();
  const second = new AtomicJsonStore();

  const mutation = first.update(filePath, { count: 0 }, async () => {
    mutationEntered.resolve();
    await releaseMutation.promise;
    return { count: 1 };
  });
  await mutationEntered.promise;
  const read = second.read(filePath, { count: 0 });
  releaseMutation.resolve();

  assert.deepEqual(await read, { count: 1 });
  await mutation;
});
