/* No production exports. Protect bounded immutable payload reuse and failure/disposal boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import GitContentCache from "./GitContentCache";

const diff = (identity: string, patch = "patch") => ({ identity, patch, unavailable: null });

test("completed content expires by time and never crosses identities", async () => {
  let now = 0;
  let calls = 0;
  const cache = new GitContentCache({ now: () => now, ttl: 100 });
  const read = (identity: string) => cache.read("diff", identity, async () => { calls++; return diff(identity); });
  await read("a");
  await read("a");
  assert.equal(calls, 1);
  assert.equal(cache.peek("preview", "a"), null, "a diff never answers a preview");
  now = 100;
  await read("a");
  await read("b");
  assert.equal(calls, 3);
});

test("concurrent requests coalesce but failures remain retryable", async () => {
  let calls = 0;
  let finish!: () => void;
  const cache = new GitContentCache();
  const read = () => cache.read("diff", "a", async () => {
    calls++;
    if (calls === 1) { await new Promise<void>(resolve => { finish = resolve; }); throw new Error("unavailable"); }
    return diff("a", "");
  });
  const first = read();
  const duplicate = read();
  finish();
  const results = await Promise.allSettled([first, duplicate]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  await read();
  assert.equal(calls, 2);
});

test("entry and payload budgets evict old results instead of retaining unbounded content", async () => {
  let calls = 0;
  const cache = new GitContentCache({ maxEntries: 1, maxBytes: 1000 });
  const read = (target: GitContentCache, identity: string, patch = "text") =>
    target.read("diff", identity, async () => { calls++; return diff(identity, patch); });
  await read(cache, "a");
  await read(cache, "b");
  await read(cache, "a");
  assert.equal(calls, 3);
  const tooSmall = new GitContentCache({ maxBytes: 1 });
  await read(tooSmall, "a", "large payload");
  await read(tooSmall, "a", "large payload");
  assert.equal(calls, 5);
});

test("clearing ownership prevents an admitted old result from repopulating the cache", async () => {
  let finish!: () => void;
  let calls = 0;
  const cache = new GitContentCache();
  const read = () => cache.read("diff", "a", async () => {
    if (++calls === 1) await new Promise<void>(resolve => { finish = resolve; });
    return diff("a", "");
  });
  const retired = read();
  cache.clear();
  finish();
  await retired;
  await read();
  await read();
  assert.equal(calls, 2);
});
