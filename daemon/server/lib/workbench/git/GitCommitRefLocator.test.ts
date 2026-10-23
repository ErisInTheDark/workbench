/*
 * Exports: none. Protect verified commit-to-ref lookups: answers always match a fresh scan, while repeat and
 * self-published lookups avoid scanning.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import GitCommitRefLocator from "./GitCommitRefLocator";

const NAMESPACE = "refs/worktree/agents/codex/owner/checkpoints";

/** A fake ref store standing in for Git: scans list it, verifies read it, and both are counted. */
function refStore(initial: Record<string, string>) {
  const refs = new Map(Object.entries(initial));
  const counts = { scans: 0 };
  return {
    counts,
    refs,
    source: {
      scan: async () => {
        counts.scans += 1;
        return [...refs].sort(([left], [right]) => left.localeCompare(right)).map(([ref, value]) => ({ ref, value }));
      },
      verify: async (ref: string) => refs.get(ref) ?? null,
    },
  };
}

test("repeat lookups verify instead of rescanning, and answers follow refs changed behind the index", async () => {
  const root = "/repo/external";
  const store = refStore({ [`${NAMESPACE}/1-aaa`]: "aaa", [`${NAMESPACE}/2-bbb`]: "bbb" });
  const locator = GitCommitRefLocator.for(root, [NAMESPACE]);
  assert.equal(await locator.locate("aaa", store.source), `${NAMESPACE}/1-aaa`);
  assert.equal(await locator.locate("bbb", store.source), `${NAMESPACE}/2-bbb`);
  assert.equal(store.counts.scans, 1, "one listing serves every later hit");

  store.refs.delete(`${NAMESPACE}/1-aaa`);
  assert.equal(await locator.locate("aaa", store.source), null, "a deleted ref is never reported");
  store.refs.set(`${NAMESPACE}/3-bbb`, "ccc");
  store.refs.set(`${NAMESPACE}/0-bbb`, "bbb");
  store.refs.delete(`${NAMESPACE}/2-bbb`);
  assert.equal(await locator.locate("bbb", store.source), `${NAMESPACE}/0-bbb`, "a moved ref is found by rescanning");
  assert.equal(await locator.locate("ccc", store.source), `${NAMESPACE}/3-bbb`);
});

test("observed publications hit without scanning, and ties pick the smallest ref name", async () => {
  const root = "/repo/observed";
  const store = refStore({ [`${NAMESPACE}/2-aaa`]: "aaa", [`${NAMESPACE}/1-aaa`]: "aaa" });
  const locator = GitCommitRefLocator.for(root, [NAMESPACE]);
  assert.equal(await locator.locate("aaa", store.source), `${NAMESPACE}/1-aaa`);

  store.refs.set(`${NAMESPACE}/3-ddd`, "ddd");
  GitCommitRefLocator.observe(root, [{ newValue: "ddd", ref: `${NAMESPACE}/3-ddd` }, { newValue: "x", ref: "refs/heads/main" }], []);
  assert.equal(await locator.locate("ddd", store.source), `${NAMESPACE}/3-ddd`);
  store.refs.delete(`${NAMESPACE}/1-aaa`);
  GitCommitRefLocator.observe(root, [], [{ ref: `${NAMESPACE}/1-aaa` }]);
  assert.equal(await locator.locate("aaa", store.source), `${NAMESPACE}/2-aaa`);
  assert.equal(store.counts.scans, 1, "publications this process made keep the index current");
});
