/*
 * Exports:
 * - No production exports; tests preserve scoped drafts and canonical identity adoption.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import { appStateClientTables } from "workbench-shared/state/workbench-app-state-schema";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

test("peer registration resolves a browser-private owner distinct from its durable daemon id", async () => {
  const daemonId = DaemonIdSchema.parse("902902c0-9512-40be-bb06-c65d86ef2029");
  const registrationId = "peer-registration";
  const rows = Object.fromEntries(Object.keys(appStateClientTables).map(name => [name, []]));
  let registered = false;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push(`${options?.method ?? "GET"} ${url}`);
    if (url.endsWith("/daemon-register")) {
      registered = true;
      return Response.json({ registrationId, state: {} });
    }
    return Response.json({
      kind: "snapshot", daemonRegistrationId: "attached-registration",
      registrations: registered ? [
        { id: "attached-registration", kind: "local", daemonId: null },
        { id: registrationId, kind: "remote", daemonId },
      ] : [{ id: "attached-registration", kind: "local", daemonId: null }],
      oldestAvailableRevision: 0, revision: registered ? 1 : 0, schemaVersion: 1, rows,
    });
  };
  const state = new WorkbenchClientStateController({
    fetcher, mode: "http", visibility: { hidden: () => true, subscribe: () => () => {} },
  });
  try {
    await state.bootstrap();
    assert.deepEqual(await Promise.all([
      state.ensureDaemonRegistration(daemonId, false),
      state.ensureDaemonRegistration(daemonId, false),
    ]), [registrationId, registrationId]);
    assert.equal(state.getSnapshot().registrations.find(item => item.daemonId === daemonId)?.id, registrationId);
    assert.deepEqual(requests, [
      "GET /api/workbench-client-state",
      "POST /api/workbench-client-state/daemon-register",
      "GET /api/workbench-client-state",
    ]);
  } finally {
    state.dispose();
  }
});

test("conversion flattens retained project aliases while preserving drafts and later edits", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const old = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const projectId = testProjectIds.project;
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: "memory", projectId: "old/path", threadId: "native" };
  const value = { text: "retained", attachments: [], updatedAt: 1 };
  try {
    await state.put({ ...identity, value });
    state.rememberThreadIdentityAlias(identity.projectId, "native", "wb");
    await state.adoptProjectAliases([{ alias: identity.projectId, projectId: old }]);
    const conversion = [{ alias: identity.projectId, projectId }, { alias: old, projectId }];
    await state.adoptProjectAliases(conversion);
    await state.adoptProjectAliases(conversion);
    assert.deepEqual(state.records("composerDraft"), [{ ...identity, projectId, threadId: "wb", value }]);
    await state.put({ ...identity, value: { ...value, text: "late edit" } });
    assert.deepEqual(state.records("composerDraft"), [{ ...identity, projectId, threadId: "wb", value: { ...value, text: "late edit" } }]);
  } finally { state.dispose(); }
});

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

test("equal aliases on two daemon registrations resolve and persist independently", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const attached = ProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const peer = ProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  try {
    await state.put({ kind: "composerDraft", daemonRegistrationId: "memory",
      projectId: "old", threadId: "native", value: { text: "attached", attachments: [], updatedAt: 1 } });
    await state.put({ kind: "composerDraft", daemonRegistrationId: "peer-registration",
      projectId: "old", threadId: "native", value: { text: "peer", attachments: [], updatedAt: 1 } });
    state.rememberThreadIdentityAlias("old", "native", "thread-attached");
    state.rememberThreadIdentityAlias("old", "native", "thread-peer", "peer-registration");
    await state.adoptProjectAliases([{ alias: "old", projectId: attached }]);
    await state.adoptProjectAliases([{ alias: "old", projectId: peer }], "peer-registration");
    assert.equal(state.resolveProjectId("old"), attached);
    assert.equal(state.resolveProjectId("old", "peer-registration"), peer);
    assert.deepEqual(state.records("composerDraft").map(record => [
      record.daemonRegistrationId, record.projectId, record.threadId, record.value.text,
    ]), [
      ["memory", attached, "thread-attached", "attached"],
      ["peer-registration", peer, "thread-peer", "peer"],
    ]);
  } finally {
    state.dispose();
  }
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
