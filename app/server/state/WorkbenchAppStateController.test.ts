/* No production exports. Tests protect revisioned preferences, app-state mutation and structured draft hydration. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";

import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import type { WorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { appStateSchema } from "workbench-shared/state/workbench-app-state-schema";

import WorkbenchAppStateController from "./WorkbenchAppStateController.ts";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { conformWorkbenchClientStateResponse } from "../../client/workbench/state/workbench-client-state-conformance";

test("fractional font sizes survive global and project saves, browser conformance and restart", async context => {
  const fixture = await controllerFixture(context);
  const records = [
    { kind: "globalPreference" as const, preference: { key: "editorFontSize" as const, value: 1.16 } },
    { kind: "projectPreference" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "project", preference: { key: "editorFontSize" as const, enabled: true, value: 1.48 } },
  ];
  try {
    for (const record of records) {
      const saved = await fixture.controller.mutate({ action: "put", record });
      const conformed = conformWorkbenchClientStateResponse(saved);
      assert.equal(conformed.success, true);
      assert.deepEqual(projectedRecords(saved), [record]);
    }
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(projectedRecords(restarted.read()).filter(record => record.kind === "globalPreference" || record.kind === "projectPreference"), records);
  } finally { await restarted.close(); }
});

function projectedRecords(response: WorkbenchClientStateResponse) {
  return projectWorkbenchClientStateRows(response.rows).flatMap((change) => (
    change.change === "upsert" ? [change.record] : []
  ));
}

test("UUID conversion flattens saved aliases without resurrecting deleted drafts across restart", async context => {
  const fixture = await controllerFixture(context);
  const old = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const projectId = testProjectIds.project;
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old/path", threadId: "live" };
  const value = { text: "retained", attachments: [{ id: "image", url: "attachment" }], updatedAt: 1 };
  try {
    for (const threadId of ["live", "deleted"]) {
      await fixture.controller.mutate({ action: "put", record: { ...identity, threadId, value } });
    }
    await fixture.controller.remapProjects({ daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: identity.projectId, projectId: old }] });
    await fixture.controller.mutate({ action: "delete", identity: { ...identity, threadId: "deleted" } });
    const request = { daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: identity.projectId, projectId }, { alias: old, projectId }] };
    await fixture.controller.remapProjects(request);
    await fixture.controller.remapProjects(request);
    assert.deepEqual(projectedRecords(fixture.controller.read()).filter(row => row.kind === "composerDraft"), [{ ...identity, projectId, value }]);
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    await restarted.mutate({ action: "put", record: { ...identity, value: { ...value, text: "late edit" } } });
    assert.deepEqual(projectedRecords(restarted.read()).filter(row => row.kind === "composerDraft"), [
      { ...identity, projectId, value: { ...value, text: "late edit" } },
    ]);
  } finally { await restarted.close(); }
});

test("project remapping preserves draft attachments and launch selection across restart and late old-address saves", async context => {
  const fixture = await controllerFixture(context);
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const request = { daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: "old", projectId }] };
  const draft = {
    kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread",
    value: { text: "keep this draft", updatedAt: 1, attachments: [{ id: "attachment", url: "data:image/png;base64,YQ==" }] },
  };
  try {
    await fixture.controller.mutate({ action: "put", record: draft });
    await fixture.controller.mutate({ action: "put", record: {
      kind: "lastLaunchTarget", daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old",
    } });
    const delta = await fixture.controller.remapProjects(request);
    assert.ok(projectWorkbenchClientStateRows(delta.rows).some(change => change.change === "delete"
      && "projectId" in change.identity && change.identity.projectId === "old"));
    const records = projectedRecords(fixture.controller.read());
    assert.deepEqual(records.find(record => record.kind === "composerDraft"), { ...draft, projectId });
    assert.equal(records.find(record => record.kind === "lastLaunchTarget")?.projectId, projectId);
    await fixture.controller.remapProjects(request);
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    await restarted.mutate({ action: "put", record: { ...draft, value: { ...draft.value, text: "late edit" } } });
    assert.deepEqual(projectedRecords(restarted.read()).filter(record => record.kind === "composerDraft"), [
      { ...draft, projectId, value: { ...draft.value, text: "late edit" } },
    ]);
    await restarted.mutate({ action: "delete", identity: {
      kind: "composerDraft", daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread",
    } });
    assert.equal(projectedRecords(restarted.read()).filter(record => record.kind === "composerDraft").length, 0);
  } finally { await restarted.close(); }
});

test("project remap conflicts roll back records and aliases without losing either draft", async context => {
  const fixture = await controllerFixture(context);
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const request = { daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: "old", projectId }] };
  try {
    for (const id of ["old", projectId]) await fixture.controller.mutate({ action: "put", record: {
      kind: "composerDraft", daemonRegistrationId: fixture.daemonRegistrationId, projectId: id, threadId: "thread",
      value: { text: id, updatedAt: 1, attachments: [] },
    } });
    const before = fixture.controller.read();
    await assert.rejects(fixture.controller.remapProjects(request), /conflict/i);
    assert.deepEqual(fixture.controller.read(), before);
    await fixture.controller.mutate({ action: "put", record: {
      kind: "expandedDirectory", daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", path: "src",
    } });
    assert.equal(projectedRecords(fixture.controller.read()).find(record => record.kind === "expandedDirectory")?.projectId, "old");
  } finally { await fixture.controller.close(); }
});

test("standalone provider favourites survive repeated saves and controller restart", async context => {
  const fixture = await controllerFixture(context);
  const record = { kind: "modelPreference" as const, harness: "future-provider", modelId: "future-model", favourite: true };
  try {
    await fixture.controller.mutate({ action: "put", record });
    await fixture.controller.mutate({ action: "put", record });
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(projectedRecords(restarted.read()).filter(row => row.kind === "modelPreference"), [record]);
  } finally { await restarted.close(); }
});

async function controllerFixture(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-controller-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const databasePath = path.join(directory, "state.sqlite3");
  const create = () => new WorkbenchAppStateController(new WorkbenchAppStateRepository({ databasePath }));
  const controller = create();
  const daemonRegistrationId = await controller.start();
  return { controller, create, daemonRegistrationId, databasePath };
}

test("a failed favourite write rolls back its provider admission and revision", async context => {
  const fixture = await controllerFixture(context);
  const database = new Database(fixture.databasePath);
  try {
    const before = fixture.controller.read();
    database.exec(`CREATE TRIGGER reject_favourite BEFORE INSERT ON model_preferences
      BEGIN SELECT RAISE(ABORT, 'test favourite failure'); END`);
    await assert.rejects(fixture.controller.mutate({ action: "put", record: {
      kind: "modelPreference", harness: "future-provider", modelId: "future-model", favourite: true,
    } }), /test favourite failure/u);
    assert.deepEqual(fixture.controller.read(), before);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_harnesses").all(), []);
  } finally {
    database.close();
    await fixture.controller.close();
  }
});

test("mutations return a revision delta and survive controller restart", async (context) => {
  const fixture = await controllerFixture(context);
  const initial = fixture.controller.read();
  assert.equal(initial.kind, "snapshot");
  const response = await fixture.controller.mutate({
    action: "put",
    record: {
      kind: "globalPreference",
      preference: { key: "theme", value: "winter" },
    },
  });
  assert.equal(response.kind, "delta");
  assert.deepEqual(response.rows.globalPreferences.map((row) => row.deleted), [0]);
  await fixture.controller.close();

  const restarted = fixture.create();
  await restarted.start();
  const snapshot = restarted.read();
  assert.ok(snapshot.kind === "snapshot" && projectedRecords(snapshot).some((record) => (
    record.kind === "globalPreference"
    && record.preference.key === "theme"
    && record.preference.value === "winter"
  )));
  await restarted.close();
});

test("numeric app port preferences survive through the global state owner", async (context) => {
  const fixture = await controllerFixture(context);
  assert.equal(fixture.controller.readGlobalPreference("appPort"), null);
  await fixture.controller.mutate({
    action: "put",
    record: {
      kind: "globalPreference",
      preference: { key: "appPort", value: 43_210 },
    },
  });
  assert.equal(fixture.controller.readGlobalPreference("appPort"), 43_210);
  await fixture.controller.close();

  const restarted = fixture.create();
  await restarted.start();
  assert.equal(restarted.readGlobalPreference("appPort"), 43_210);
  await restarted.close();
});

test("global sidebar preferences persist boolean and numeric scalar families", async (context) => {
  const fixture = await controllerFixture(context);
  assert.equal(fixture.controller.read().schemaVersion, appStateSchema.currentVersion);
  await fixture.controller.mutate({
    action: "put",
    record: {
      kind: "globalPreference",
      preference: { key: "projectsOpen", value: true },
    },
  });
  await fixture.controller.mutate({
    action: "put",
    record: {
      kind: "globalPreference",
      preference: { key: "projectTimeGroupCount", value: 4 },
    },
  });
  await fixture.controller.close();

  const restarted = fixture.create();
  await restarted.start();
  assert.equal(restarted.readGlobalPreference("projectsOpen"), true);
  assert.equal(restarted.readGlobalPreference("projectTimeGroupCount"), 4);
  await restarted.close();
});

test("a future revision receives a complete snapshot instead of an invalid delta", async (context) => {
  const { controller } = await controllerFixture(context);
  const response = controller.read(Number.MAX_SAFE_INTEGER);
  assert.equal(response.kind, "snapshot");
  await controller.close();
});

test("composer and questionnaire draft children hydrate with their owning draft", async (context) => {
  const { controller, daemonRegistrationId } = await controllerFixture(context);
  await controller.mutate({
    action: "put",
    record: {
      daemonRegistrationId,
      kind: "composerDraft",
      projectId: "project",
      threadId: "thread",
      value: { attachments: [{ id: "image", url: "asset://image" }], text: "draft", updatedAt: 10 },
    },
  });
  await controller.mutate({
    action: "put",
    record: {
      daemonRegistrationId,
      kind: "questionnaireDraft",
      projectId: "project",
      requestKey: "request",
      threadId: "thread",
      value: {
        attachments: [{ id: "question-image", url: "asset://question" }],
        customValues: { question: "custom" },
        selectedValues: { choice: ["one", "two"] },
        updatedAt: 20,
      },
    },
  });
  const snapshot = controller.read();
  const records = projectedRecords(snapshot);
  assert.ok(snapshot.kind === "snapshot" && records.some((record) => (
    record.kind === "composerDraft"
    && record.value.attachments[0]?.url === "asset://image"
  )));
  assert.ok(snapshot.kind === "snapshot" && records.some((record) => (
    record.kind === "questionnaireDraft"
    && record.value.customValues.question === "custom"
    && record.value.selectedValues.choice?.length === 2
  )));
  await controller.close();
});
