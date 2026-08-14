/*
 * Exports:
 * - No production exports; Node tests cover exact-key raw thread source ownership. Keywords: thread, source, revision, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "../../types.ts";
import ThreadSourceStore from "./ThreadSourceStore.ts";

function thread(harness: ThreadPayload["harness"], id = "same"): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness, id, isDraft: false, model: null, name: null, path: null, preview: "", reasoningEffort: null,
    serviceTier: null, source: harness, status: "active", tokenUsage: null, turnHistory: [], turns: [], unreadBadge: null, updatedAt: 1,
  };
}

test("ThreadSourceStore isolates harness keys and owns revisions", () => {
  const store = ThreadSourceStore();
  const codex = thread("codex");
  const copilot = thread("copilot");
  assert.equal(store.install(codex), "codex:same");
  assert.equal(store.install(copilot), "copilot:same");
  assert.equal(store.getRevision("codex:same"), 1);
  assert.equal(store.get("copilot:same"), copilot);
  assert.equal(store.update("codex:same", (value) => ({ ...value, name: "renamed" })), true);
  assert.equal(store.getRevision("codex:same"), 2);
  assert.throws(() => store.update("codex:same", (value) => ({ ...value, harness: "opencode" })));
  assert.equal(store.delete("codex:same"), true);
  assert.equal(store.getRevision("codex:same"), 3);
  assert.equal(store.get("copilot:same"), copilot);
});

test("ThreadSourceStore rejects null and key-changing updates without mutation", () => {
  const store = ThreadSourceStore();
  const source = thread("codex", "thread");
  store.install(source);
  assert.equal(store.update("codex:thread", () => null), false);
  assert.equal(store.getRevision("codex:thread"), 1);
  assert.throws(() => store.update("codex:thread", (value) => ({ ...value, id: "other" })));
  assert.equal(store.get("codex:thread"), source);
});

test("ThreadSourceStore clear owns source removal without presentation state", () => {
  const store = ThreadSourceStore();
  store.install(thread("codex"));
  store.clear();
  assert.equal(store.has("codex:same"), false);
  assert.equal(store.get("codex:same"), null);
});
