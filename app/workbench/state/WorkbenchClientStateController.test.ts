/*
 * Keywords: draft, identity alias, storage ownership, canonical view.
 * No exports. Tests preserve native-keyed drafts while canonical views edit them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

test("canonical draft edits and deletion retain the original physical address", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: "memory", projectId: "project", threadId: "native" };
  const value = { text: "retained", attachments: [], updatedAt: 1 };
  await state.put({ ...identity, value });
  state.rememberThreadIdentityAlias("project", "native", "wb");
  assert.equal(state.records("composerDraft")[0]?.threadId, "wb");
  await state.put({ ...identity, threadId: "wb", value: { ...value, text: "edited", updatedAt: 2 } });
  assert.equal(state.records("composerDraft").length, 1);
  assert.equal(state.records("composerDraft")[0]?.value.text, "edited");
  await state.delete({ ...identity, threadId: "wb" });
  assert.deepEqual(state.records("composerDraft"), []);
  state.dispose();
});
