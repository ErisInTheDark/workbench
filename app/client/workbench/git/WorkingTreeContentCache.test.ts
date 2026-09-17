/* No production exports. Protect bounded immutable payload reuse and failure/disposal boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkingTreeContentCache from "./WorkingTreeContentCache";

const request = { projectId: "project", rootId: "root", path: "a", identity: "version-a" };
const preview = async () => ({ identity: request.identity, before: null, after: null, encoding: "text" as const, mime: "text/plain", unavailable: null });

test("completed content expires by time and cannot cross paths, identities or repository roots", async () => {
  let now = 0;
  let calls = 0;
  const cache = new WorkingTreeContentCache({
    diff: async input => { calls++; return { identity: input.identity, patch: "patch", unavailable: null }; }, preview,
  }, { now: () => now, ttl: 100 });
  await cache.readDiff(request, "/repo");
  await cache.readDiff(request, "/repo");
  assert.equal(calls, 1);
  now = 100;
  await cache.readDiff(request, "/repo");
  await cache.readDiff({ ...request, identity: "version-b" }, "/repo");
  await cache.readDiff({ ...request, path: "b" }, "/repo");
  await cache.readDiff(request, "/other");
  assert.equal(calls, 5);
});

test("concurrent requests coalesce but failures remain retryable", async () => {
  let calls = 0;
  let finish!: () => void;
  const cache = new WorkingTreeContentCache({
    diff: async input => {
      calls++;
      if (calls === 1) { await new Promise<void>(resolve => { finish = resolve; }); throw new Error("unavailable"); }
      return { identity: input.identity, patch: "", unavailable: null };
    }, preview,
  });
  const first = cache.readDiff(request, "/repo");
  const duplicate = cache.readDiff(request, "/repo");
  finish();
  const results = await Promise.allSettled([first, duplicate]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  await cache.readDiff(request, "/repo");
  assert.equal(calls, 2);
});

test("entry and payload budgets evict old results instead of retaining unbounded content", async () => {
  let calls = 0;
  const cache = new WorkingTreeContentCache({
    diff: async input => { calls++; return { identity: input.identity, patch: "text", unavailable: null }; }, preview,
  }, { maxEntries: 1, maxBytes: 1000 });
  await cache.readDiff(request, "/repo");
  await cache.readDiff({ ...request, path: "b" }, "/repo");
  await cache.readDiff(request, "/repo");
  assert.equal(calls, 3);
  const tooSmall = new WorkingTreeContentCache({
    diff: async input => { calls++; return { identity: input.identity, patch: "large payload", unavailable: null }; }, preview,
  }, { maxBytes: 1 });
  await tooSmall.readDiff(request, "/repo");
  await tooSmall.readDiff(request, "/repo");
  assert.equal(calls, 5);
});

test("clearing ownership prevents an admitted old result from repopulating the cache", async () => {
  let finish!: () => void;
  let calls = 0;
  const cache = new WorkingTreeContentCache({
    diff: async input => {
      if (++calls === 1) await new Promise<void>(resolve => { finish = resolve; });
      return { identity: input.identity, patch: "", unavailable: null };
    }, preview,
  });
  const retired = cache.readDiff(request, "/repo");
  cache.clear();
  finish();
  await retired;
  await cache.readDiff(request, "/repo");
  await cache.readDiff(request, "/repo");
  assert.equal(calls, 2);
});
