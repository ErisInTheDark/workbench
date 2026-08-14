/*
 * Exports:
 * - No production exports; Node tests cover exact-key document deletion and selection. Keywords: thread, document, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "../../types.ts";
import ThreadDocumentStore from "./ThreadDocumentStore.ts";

function thread(harness: ThreadPayload["harness"]): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness, id: "same", isDraft: false, model: null, name: null, path: null, preview: "", reasoningEffort: null,
    serviceTier: null, source: harness, status: "active", tokenUsage: null, turnHistory: [], turns: [], unreadBadge: null, updatedAt: 1,
  };
}

test("deleteDocumentKey preserves a newer same-id harness index", () => {
  const store = ThreadDocumentStore();
  store.upsertDocument(thread("codex"), { select: true });
  store.upsertDocument(thread("copilot"), { select: true });
  assert.equal(store.deleteDocumentKey("codex:same"), true);
  assert.equal(store.getSelectedThreadKey(), "copilot:same");
  assert.equal(store.getDocumentByThreadId("same")?.harness, "copilot");
  assert.equal(store.deleteDocumentKey("copilot:same"), true);
  assert.equal(store.getSelectedThreadKey(), "");
  assert.equal(store.getDocumentByThreadId("same"), null);
});

test("one exact selected key coordinates selected document and snapshot", () => {
  const store = ThreadDocumentStore();
  const source = thread("codex");
  store.materializeFinalVisibleDocument("codex:same", source, { select: true });
  assert.equal(store.getSelectedThreadKey(), "codex:same");
  assert.equal(store.getSelectedDocument(), source);
  assert.equal(store.getSnapshot().selectedThreadKey, "codex:same");
});

test("draft harness replacement installs and selects new key before deleting old", () => {
  const store = ThreadDocumentStore();
  store.upsertDocument(thread("codex"), { select: true });
  store.upsertDocument(thread("opencode"), { select: true });
  store.deleteDocumentKey("codex:same");
  assert.equal(store.getSelectedThreadKey(), "opencode:same");
  assert.equal(store.getDocumentByThreadId("same")?.harness, "opencode");
});
