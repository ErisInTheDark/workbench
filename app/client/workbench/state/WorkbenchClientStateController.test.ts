/*
 * Exports:
 * - No production exports; tests preserve scoped drafts and canonical identity adoption.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

test("project and thread delimiters cannot alias independent drafts", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  try {
    const first = { kind: "composerDraft" as const, daemonRegistrationId: "memory", projectId: "local://C:/repo:part", threadId: "thread" };
    const second = { ...first, projectId: "local://C:/repo", threadId: "part:thread" };
    await state.put({ ...first, value: { text: "first", attachments: [], updatedAt: 1 } });
    await state.put({ ...second, value: { text: "second", attachments: [], updatedAt: 1 } });
    assert.equal(state.records("composerDraft").length, 2);
    assert.deepEqual(state.records("composerDraft").map(({ projectId, threadId }) => ({ projectId, threadId })), [
      { projectId: first.projectId, threadId: first.threadId },
      { projectId: second.projectId, threadId: second.threadId },
    ]);
    await state.delete(first);
    assert.equal(state.records("composerDraft")[0]?.value.text, "second");
  } finally { state.dispose(); }
});

test("combined project adoption rejects conflicting native thread aliases before changing ownership", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const projectId = ProjectIdSchema.parse("remote://example.test/repo");
  try {
    state.rememberThreadIdentityAlias("old-a", "native", "wb-a");
    state.rememberThreadIdentityAlias("old-b", "native", "wb-b");
    await assert.rejects(state.adoptProjectAliases([
      { alias: "old-a", projectId }, { alias: "old-b", projectId },
    ]), /conflict/i);
    assert.equal(state.resolveProjectId("old-a"), "old-a");
    assert.equal(state.resolveProjectId("old-b"), "old-b");
  } finally { state.dispose(); }
});

test("project adoption keeps native thread aliases and accepts later edits through either project address", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: "memory", projectId: "old", threadId: "native" };
  const value = { text: "retained", attachments: [{ id: "a", url: "attachment" }], updatedAt: 1 };
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  try {
    await state.put({ ...identity, value });
    state.rememberThreadIdentityAlias("old", "native", "wb");
    await state.adoptProjectAliases([{ alias: "old", projectId }]);
    assert.deepEqual(state.records("composerDraft"), [{ ...identity, projectId, threadId: "wb", value }]);
    await state.put({ ...identity, threadId: "wb", value: { ...value, text: "edited" } });
    assert.equal(state.records("composerDraft").length, 1);
    assert.equal(state.records("composerDraft")[0]!.value.text, "edited");
    await state.delete({ ...identity, projectId, threadId: "wb" });
    assert.deepEqual(state.records("composerDraft"), []);
  } finally { state.dispose(); }
});

test("memory project adoption rejects conflicting drafts without choosing a winner", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  try {
    for (const id of ["old", projectId]) await state.put({
      kind: "composerDraft", daemonRegistrationId: "memory", projectId: id, threadId: "thread",
      value: { text: id, attachments: [], updatedAt: 1 },
    });
    const before = state.records("composerDraft");
    await assert.rejects(state.adoptProjectAliases([{ alias: "old", projectId }]), /conflict/i);
    assert.deepEqual(state.records("composerDraft"), before);
    assert.equal(state.resolveProjectId("old"), "old");
  } finally { state.dispose(); }
});

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
