/* No production exports. Protect pushed state, optimistic saves and identity-scoped revision fencing. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { WorkbenchClientStateResponse, WorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { conformWorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state-conformance";
import { createWorkspaceClientFixture } from "../app/workspace-client-fixture";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

function response(revision: number, rows: Partial<WorkbenchClientStateRows> = {},
  kind: "snapshot" | "delta" = "delta"): WorkbenchClientStateResponse {
  return {
    daemonRegistrationId: "registration", kind, oldestAvailableRevision: 0, revision, schemaVersion: 0,
    rows: {
      composerDraftAttachments: [], composerDrafts: [], fileDrafts: [], globalPreferences: [],
      modelPreferences: [], modelGroupDisclosures: [], lastLaunchTarget: [], projectExpandedDirectories: [], projectPreferences: [],
      projectSidebarFolders: [], projectSidebarPreferences: [], questionnaireDraftAnswers: [],
      questionnaireDraftAttachments: [], questionnaireDraftSelections: [], questionnaireDrafts: [], ...rows,
    },
  };
}

const identity = {
  kind: "composerDraft" as const, daemonRegistrationId: "registration", projectId: "project", threadId: "thread",
};
const record = (text: string, updatedAt = 1) => ({ ...identity, value: { text, updatedAt, attachments: [] } });
function draftResponse(revision: number, text: string, deleted = false) {
  return response(revision, { composerDrafts: [{
    daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId,
    thread_id: identity.threadId, revision, text: deleted ? null : text,
    updated_at: deleted ? null : revision, deleted: deleted ? 1 : 0,
  }] });
}

async function fixture(context: TestContext, initial = response(0, {}, "snapshot")) {
  const connection = createWorkspaceClientFixture();
  const socket = await connection.open();
  const state = new WorkbenchClientStateController({
    workspace: connection.workspace,
    browserStateId: "10000000-0000-4000-8000-000000000001",
  });
  context.after(() => { state.dispose(); connection.dispose(); });
  await state.bootstrap();
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "appState");
  let revision = 0;
  const push = (data: WorkbenchClientStateResponse) => socket.observation(query, {
    kind: "appState", phase: "current", failure: null, data,
  }, ++revision);
  push(initial);
  return { state, socket, push, query };
}

test("workspace state is pushed and an unchanged fact keeps its external-store identity", async context => {
  const f = await fixture(context);
  const snapshot = f.state.getSnapshot();
  await f.state.bootstrap();
  f.push(response(0, {}, "snapshot"));
  assert.equal(f.state.getSnapshot(), snapshot);
  assert.equal(f.socket.sent.filter(request => request.method === "workspace/observe"
    && request.params.query.kind === "appState").length, 1);
  f.push(draftResponse(1, "remote"));
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "remote");
});

test("same-identity saves stay ordered while newer optimistic text survives the first acknowledgement", async context => {
  const f = await fixture(context);
  const start = f.socket.sent.length;
  const first = f.state.put(record("first"));
  const second = f.state.put(record("second", 2));
  const request = await f.socket.request("app/state/mutate", start);
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "second");
  assert.equal(f.socket.sent.slice(start).filter(frame => frame.method === "app/state/mutate").length, 1);
  const next = f.socket.sent.length;
  f.socket.reply(request, draftResponse(1, "first"));
  await first;
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "second");
  const later = await f.socket.request("app/state/mutate", next);
  f.socket.reply(later, draftResponse(2, "second"));
  await second;
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "second");
});

test("an old save acknowledgement cannot overwrite a newer push or resurrect its deletion", async context => {
  for (const deleted of [false, true]) {
    const f = await fixture(context);
    const start = f.socket.sent.length;
    const saving = f.state.put(record("old"));
    const request = await f.socket.request("app/state/mutate", start);
    f.push(draftResponse(2, "new", deleted));
    f.socket.reply(request, draftResponse(1, "old"));
    await saving;
    assert.equal(f.state.records("composerDraft")[0]?.value.text, deleted ? undefined : "new");
  }
});

test("out-of-order acknowledgements for unrelated rows retain both confirmed changes", async context => {
  const f = await fixture(context);
  const start = f.socket.sent.length;
  const left = f.state.put({ kind: "globalPreference", preference: { key: "composerSpellCheck", value: true } });
  const right = f.state.put({ kind: "globalPreference", preference: { key: "editorSpellCheck", value: true } });
  const a = await f.socket.request("app/state/mutate", start, request =>
    request.params.mutation.action === "put" && request.params.mutation.record.kind === "globalPreference"
    && request.params.mutation.record.preference.key === "composerSpellCheck");
  const b = await f.socket.request("app/state/mutate", start, request => request.id !== a.id);
  const preference = (revision: number, key: "composerSpellCheck" | "editorSpellCheck") => response(revision, {
    globalPreferences: [{ key, revision, boolean_value: 1, integer_value: null, text_value: null, deleted: 0 }],
  });
  f.socket.reply(b, preference(2, "editorSpellCheck")); await right;
  f.socket.reply(a, preference(1, "composerSpellCheck")); await left;
  assert.deepEqual(f.state.records("globalPreference").map(record => record.preference.key).sort(),
    ["composerSpellCheck", "editorSpellCheck"]);
});

test("model section edits keep independent optimistic identities and roll back only a failed section", async context => {
  const f = await fixture(context);
  const start = f.socket.sent.length;
  const codex = f.state.put({ kind: "modelGroupDisclosure", groupId: "provider:codex", open: false });
  const opencode = f.state.put({ kind: "modelGroupDisclosure", groupId: "provider:opencode:opencode-go", open: false });
  const codexRequest = await f.socket.request("app/state/mutate", start, request =>
    request.params.mutation.action === "put"
    && request.params.mutation.record.kind === "modelGroupDisclosure"
    && request.params.mutation.record.groupId === "provider:codex");
  const opencodeRequest = await f.socket.request("app/state/mutate", start, request => request.id !== codexRequest.id);
  assert.deepEqual(f.state.records("modelGroupDisclosure").map(record => record.groupId).sort(), [
    "provider:codex", "provider:opencode:opencode-go",
  ]);
  f.socket.reply(opencodeRequest, response(2, { modelGroupDisclosures: [{
    group_id: "provider:opencode:opencode-go", open: 0, deleted: 0, revision: 2,
  }] }));
  await opencode;
  f.socket.fail(codexRequest, "write failed");
  await assert.rejects(codex, /write failed/);
  assert.deepEqual(f.state.records("modelGroupDisclosure"), [{
    kind: "modelGroupDisclosure", groupId: "provider:opencode:opencode-go", open: false,
  }]);
});

test("a full snapshot fences absent rows but preserves acknowledgements newer than itself", async context => {
  const f = await fixture(context);
  const start = f.socket.sent.length;
  const saving = f.state.put(record("newest"));
  const request = await f.socket.request("app/state/mutate", start);
  f.socket.reply(request, draftResponse(3, "newest"));
  await saving;
  f.push(response(2, {}, "snapshot"));
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "newest");
  f.push(response(4, {}, "snapshot"));
  f.push(draftResponse(3, "newest"));
  assert.deepEqual(f.state.records("composerDraft"), []);
});

test("a failed optimistic mutation reveals the newest received fact without automatic retry", async context => {
  const f = await fixture(context, { ...draftResponse(1, "saved"), kind: "snapshot" });
  const start = f.socket.sent.length;
  const saving = f.state.put(record("optimistic"));
  const request = await f.socket.request("app/state/mutate", start);
  f.push(draftResponse(2, "other browser"));
  f.socket.fail(request, "write failed");
  await assert.rejects(saving, /write failed/);
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "other browser");
  assert.equal(f.socket.sent.slice(start).filter(frame => frame.method === "app/state/mutate").length, 1);
});

test("project aliases stay daemon-scoped and retain native-thread edit addresses", async context => {
  const initial = response(1, { composerDrafts: ["registration", "peer-registration"].map((daemon_registration_id, index) => ({
    daemon_registration_id, project_id: "old", thread_id: "native", revision: 1,
    text: `source ${index}`, updated_at: 1, deleted: 0,
  })) }, "snapshot");
  const f = await fixture(context, initial);
  f.state.rememberThreadIdentityAlias("old", "native", "attached-thread");
  f.state.rememberThreadIdentityAlias("old", "native", "peer-thread", "peer-registration");
  const attached = ProjectIdSchema.parse("attached-project");
  const peer = ProjectIdSchema.parse("peer-project");
  const remapped = response(2, { composerDrafts: initial.rows.composerDrafts.map(row => ({
    ...row, project_id: row.daemon_registration_id === "registration" ? attached : peer, revision: 2,
  })) }, "snapshot");
  remapped.projectAliases = [
    { daemonRegistrationId: "registration", aliases: [{ alias: "old", projectId: attached }] },
    { daemonRegistrationId: "peer-registration", aliases: [{ alias: "old", projectId: peer }] },
  ];
  f.push(remapped);
  assert.deepEqual(f.state.records("composerDraft").map(record => [record.projectId, record.threadId]), [
    [attached, "attached-thread"], [peer, "peer-thread"],
  ]);
  const start = f.socket.sent.length;
  const saving = f.state.put({ ...record("edit"), projectId: "old", threadId: "attached-thread" });
  const request = await f.socket.request("app/state/mutate", start);
  assert.equal(request.params.mutation.action, "put");
  if (request.params.mutation.action !== "put" || request.params.mutation.record.kind !== "composerDraft") assert.fail();
  assert.equal(request.params.mutation.record.projectId, attached);
  assert.equal(request.params.mutation.record.threadId, "native");
  f.socket.reply(request, response(3, { composerDrafts: [{
    ...remapped.rows.composerDrafts[0]!, text: "edit", revision: 3,
  }] }));
  await saving;
  assert.equal(f.state.records("composerDraft").length, 2);
});

test("project and thread delimiters cannot alias independent local drafts", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  try {
    const first = { ...identity, projectId: "a|b", threadId: "c" };
    const second = { ...identity, projectId: "a", threadId: "b|c" };
    await state.put({ ...record("first"), ...first });
    await state.put({ ...record("second"), ...second });
    assert.equal(state.records("composerDraft").length, 2);
    await state.delete(first);
    assert.equal(state.records("composerDraft")[0]?.value.text, "second");
  } finally { state.dispose(); }
});

test("conflicting alias facts fail without partially changing ownership and later valid facts recover", async context => {
  context.mock.method(console, "warn", () => {});
  const f = await fixture(context);
  f.state.rememberThreadIdentityAlias("old-a", "native", "thread-a");
  f.state.rememberThreadIdentityAlias("old-b", "native", "thread-b");
  const canonical = ProjectIdSchema.parse("canonical");
  const conflicting = response(1, {}, "snapshot");
  conflicting.projectAliases = [{ daemonRegistrationId: "registration", aliases: [
    { alias: "old-a", projectId: canonical }, { alias: "old-b", projectId: canonical },
  ] }];
  f.push(conflicting);
  assert.match(f.state.getSnapshot().error, /conflict/);
  assert.equal(f.state.resolveProjectId("old-a"), "old-a");
  const repaired = response(2, {}, "snapshot");
  repaired.projectAliases = [{ daemonRegistrationId: "registration", aliases: [{ alias: "old-a", projectId: canonical }] }];
  f.push(repaired);
  assert.equal(f.state.getSnapshot().error, "");
  assert.equal(f.state.resolveProjectId("old-a"), canonical);
});

test("canonical draft edits and deletion preserve their stored native address", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  try {
    await state.put(record("saved"));
    state.rememberThreadIdentityAlias("project", "thread", "canonical", "registration");
    await state.put({ ...record("edited"), threadId: "canonical" });
    assert.equal(state.records("composerDraft").length, 1);
    assert.equal(state.records("composerDraft")[0]?.value.text, "edited");
    await state.delete({ ...identity, threadId: "canonical" });
    assert.deepEqual(state.records("composerDraft"), []);
  } finally { state.dispose(); }
});

test("font size facts retain both stored whole-rem and hundredth-rem encodings", async context => {
  for (const [stored, expected] of [[116, 1.16], [1, 1]]) {
    const f = await fixture(context, response(1, { globalPreferences: [{
      key: "editorFontSize", integer_value: stored!, boolean_value: null, text_value: null, deleted: 0, revision: 1,
    }] }, "snapshot"));
    assert.equal(f.state.records("globalPreference")[0]?.preference.value, expected);
    f.push(response(2));
    assert.equal(f.state.records("globalPreference")[0]?.preference.value, expected);
  }
});

test("additive table skew preserves usable facts but missing required revisions are rejected", () => {
  const initial = response(1, {}, "snapshot");
  const result = conformWorkbenchClientStateResponse({ ...initial, futureRoot: true,
    rows: { ...initial.rows, futureTable: [{ secret: "not logged" }], globalPreferences: [{
      boolean_value: 1, future_column: "newer server", key: "composerSpellCheck", revision: 1,
    }, {
      boolean_value: 1, integer_value: null, key: "futurePreference", revision: 1, text_value: null,
    }] },
  });
  assert.ok(result.success);
  assert.equal(result.data.rows.globalPreferences.length, 1);
  assert.equal(result.data.rows.globalPreferences[0]?.boolean_value, 1);
  assert.ok(result.repairedPaths.length);
  const invalid = conformWorkbenchClientStateResponse({ ...initial,
    rows: { ...initial.rows, globalPreferences: [{
      boolean_value: 1, deleted: 0, integer_value: null, key: "composerSpellCheck", text_value: null,
    }] },
  });
  assert.equal(invalid.success, false);
});
