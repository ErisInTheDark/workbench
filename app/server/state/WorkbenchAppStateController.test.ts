/* No production exports. Tests protect revisioned preferences, app-state mutation and structured draft hydration. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";

import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import type {
  WorkbenchClientStateResponse,
  WorkbenchComposerDraftValue,
} from "workbench-shared/state/workbench-client-state";
import { LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { appStateSchema } from "workbench-shared/state/workbench-app-state-schema";

import WorkbenchAppStateController from "./WorkbenchAppStateController.ts";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { conformWorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state-conformance";
import { workspaceObservationShape } from "workbench-shared/workbench/workspace/workspace-observation";
import {
  applyObservationDelta, diffObservationValue, measureObservationDelta,
} from "workbench-shared/workbench/workspace/observation-patch";

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

test("logical project preferences persist independently of physical project addresses", async context => {
  const fixture = await controllerFixture(context);
  const logicalProjectId = LogicalProjectIdSchema.parse("84c24145-0460-489c-ac05-b382b38d4b12");
  const record = {
    kind: "logicalProjectPreference" as const,
    logicalProjectId,
    preference: { enabled: true, key: "editorFontSize" as const, value: 1.18 },
  };
  try {
    await fixture.controller.mutate({ action: "put", record });
    assert.deepEqual(projectedRecords(fixture.controller.read()).filter(item =>
      item.kind === "logicalProjectPreference"), [record]);
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(projectedRecords(restarted.read()).filter(item =>
      item.kind === "logicalProjectPreference"), [record]);
  } finally { await restarted.close(); }
});

test("UUID conversion flattens saved aliases without resurrecting deleted drafts across restart", async context => {
  const fixture = await controllerFixture(context);
  const old = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const projectId = testProjectIds.project;
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old/path", threadId: "live" };
  const value = {
    text: "retained", attachments: [{ id: "image", url: "attachment" }],
    references: [], updatedAt: 1,
  };
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

test("project remapping preserves draft attachments, references and launch selection across restart and old-client saves", async context => {
  const fixture = await controllerFixture(context);
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const request = { daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: "old", projectId }] };
  const references: NonNullable<WorkbenchComposerDraftValue["references"]> = [
    {
      kind: "feedback", id: 7, daemonId: "daemon", category: "bug", title: "Stats drop",
      author: "lily", thread: "thread", createdAt: 10, report: "The drop missed its target.",
    },
    { kind: "updateIssue", text: "Keep the issue current." },
  ];
  const draft = {
    kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread",
    value: {
      text: "keep this draft", updatedAt: 1,
      attachments: [{ id: "attachment", url: "data:image/png;base64,YQ==" }],
      references,
    },
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
    const oldClientValue = {
      attachments: draft.value.attachments,
      text: "late edit",
      updatedAt: 2,
    };
    await restarted.mutate({ action: "put", record: { ...draft, value: oldClientValue } });
    assert.deepEqual(projectedRecords(restarted.read()).filter(record => record.kind === "composerDraft"), [
      { ...draft, projectId, value: { ...oldClientValue, references } },
    ]);
    await restarted.mutate({ action: "put", record: {
      ...draft,
      value: { ...oldClientValue, references: [], updatedAt: 3 },
    } });
    assert.deepEqual(projectedRecords(restarted.read()).filter(record => record.kind === "composerDraft"), [
      { ...draft, projectId, value: { ...oldClientValue, references: [], updatedAt: 3 } },
    ]);
    await restarted.mutate({ action: "delete", identity: {
      kind: "composerDraft", daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread",
    } });
    assert.equal(projectedRecords(restarted.read()).filter(record => record.kind === "composerDraft").length, 0);
  } finally { await restarted.close(); }
});

test("binary draft images follow composer and questionnaire owners through project remap", async context => {
  const fixture = await controllerFixture(context);
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const image = new Uint8Array([1, 2, 3, 4]);
  const identities = [
    { kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread" },
    { kind: "questionnaireDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "old", threadId: "thread", requestKey: "question" },
  ];
  try {
    for (const identity of identities) {
      if (identity.kind === "composerDraft") {
        await fixture.controller.mutate({ action: "put", record: {
          ...identity, value: { attachments: [], text: "saved", updatedAt: 1 },
        } });
      } else {
        await fixture.controller.mutate({ action: "put", record: {
          ...identity, value: { attachments: [], customValues: { answer: "saved" }, selectedValues: {}, updatedAt: 1 },
        } });
      }
      await fixture.controller.putAttachment(identity, "image", "image/png", image);
    }
    await fixture.controller.remapProjects({
      daemonRegistrationId: fixture.daemonRegistrationId, aliases: [{ alias: "old", projectId }],
    });
    for (const identity of identities) {
      const stored = fixture.controller.readAttachment({ ...identity, projectId }, "image");
      assert.deepEqual(stored?.content, Buffer.from(image));
      assert.equal(stored?.mediaType, "image/png");
    }
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    for (const identity of identities) {
      assert.deepEqual(restarted.readAttachment({ ...identity, projectId }, "image")?.content, Buffer.from(image));
    }
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

test("two daemon registrations retain separate state when both canonical projects are daemon", async context => {
  const fixture = await controllerFixture(context);
  const daemonProjectId = ProjectIdSchema.parse("daemon");
  const localOld = ProjectIdSchema.parse("0aa9955c-be42-4f99-a93b-54f45f94eebd");
  const remoteOld = ProjectIdSchema.parse("2df4a43e-80d8-42e8-b2e0-283f3548bff4");
  try {
    const local = await fixture.controller.registerDaemon(
      "ad0de42c-aae0-482e-b423-a704ee9d6824",
      true,
    );
    const remote = await fixture.controller.registerDaemon(
      "2bb20acb-7338-4320-ad48-2a3f4938c435",
      false,
    );

    await fixture.controller.remapProjects({
      daemonRegistrationId: local.registrationId,
      aliases: [{ alias: "daemon", projectId: localOld }],
    });
    await fixture.controller.remapProjects({
      daemonRegistrationId: remote.registrationId,
      aliases: [{ alias: "daemon", projectId: remoteOld }],
    });

    await fixture.controller.mutate({ action: "put", record: {
      kind: "projectPreference",
      daemonRegistrationId: local.registrationId,
      projectId: localOld,
      preference: { key: "theme", enabled: true, value: "winter" },
    } });
    await fixture.controller.mutate({ action: "put", record: {
      kind: "projectPreference",
      daemonRegistrationId: remote.registrationId,
      projectId: remoteOld,
      preference: { key: "theme", enabled: true, value: "magical-girl" },
    } });

    await fixture.controller.remapProjects({
      daemonRegistrationId: local.registrationId,
      aliases: [{ alias: localOld, projectId: daemonProjectId }],
    });
    await fixture.controller.remapProjects({
      daemonRegistrationId: remote.registrationId,
      aliases: [{ alias: remoteOld, projectId: daemonProjectId }],
    });

    const preferences = projectedRecords(fixture.controller.read())
      .filter(record => record.kind === "projectPreference")
      .sort((left, right) => left.daemonRegistrationId.localeCompare(right.daemonRegistrationId));

    assert.deepEqual(preferences.map(record => ({
      daemonRegistrationId: record.daemonRegistrationId,
      projectId: record.projectId,
      value: record.preference.value,
    })), [
      { daemonRegistrationId: local.registrationId, projectId: "daemon", value: "winter" },
      { daemonRegistrationId: remote.registrationId, projectId: "daemon", value: "magical-girl" },
    ].sort((left, right) => left.daemonRegistrationId.localeCompare(right.daemonRegistrationId)));

    // Repeating the catalogue aliases proves the obsolete `daemon → old UUID`
    // rows were deleted rather than left behind to recreate the cycle.
    await fixture.controller.remapProjects({
      daemonRegistrationId: local.registrationId,
      aliases: [{ alias: localOld, projectId: daemonProjectId }],
    });
    await fixture.controller.remapProjects({
      daemonRegistrationId: remote.registrationId,
      aliases: [{ alias: remoteOld, projectId: daemonProjectId }],
    });
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
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-app-state-controller-");
  const directory = temporary.path;
  context.after(() => temporary.dispose());
  const databasePath = path.join(directory, "state.sqlite3");
  const create = () => new WorkbenchAppStateController(new WorkbenchAppStateRepository({ databasePath }));
  const controller = create();
  const daemonRegistrationId = await controller.start();
  return { controller, create, daemonRegistrationId, databasePath };
}

test("one draft write publishes as one keyed row and acknowledges without daemon bindings", async context => {
  const fixture = await controllerFixture(context);
  const draft = (threadId: string, text: string) => ({
    kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId, projectId: "project", threadId,
    value: { attachments: [], text, updatedAt: 1 },
  });
  const observe = (data: WorkbenchClientStateResponse, revision: number) => ({
    kind: "appState" as const, phase: "current" as const, failure: null, data,
    subscriptionId: "00000000-0000-4000-8000-000000000001", generation: 1, revision,
  });
  try {
    for (let index = 0; index < 50; index++) {
      await fixture.controller.mutate({ action: "put", record: draft(`thread-${index}`, "x".repeat(2_000)) });
    }
    const before = observe(fixture.controller.read(), 1);
    const acknowledged = await fixture.controller.mutate({ action: "put", record: draft("thread-7", "edited") });
    assert.equal(acknowledged.projectAliases, undefined);
    assert.equal(acknowledged.registrations, undefined);
    const after = observe(fixture.controller.read(), 1);
    const shape = workspaceObservationShape("appState");
    const delta = diffObservationValue(before, after, shape);
    assert.ok(delta);
    assert.deepEqual(applyObservationDelta(before, delta, shape), after);
    assert.ok(measureObservationDelta(delta) < 1_000, `one edited draft must not resend the other 49 (${measureObservationDelta(delta)}B)`);
  } finally { await fixture.controller.close(); }
});

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

test("revision deltas carry questionnaire answers and selections only for drafts that changed", async (context) => {
  const { controller, daemonRegistrationId } = await controllerFixture(context);
  const questionnaire = (requestKey: string) => ({
    action: "put" as const,
    record: {
      daemonRegistrationId, kind: "questionnaireDraft" as const, projectId: "project", requestKey, threadId: "thread",
      value: { attachments: [], customValues: { question: requestKey }, selectedValues: { choice: [requestKey] }, updatedAt: 20 },
    },
  });
  await controller.mutate(questionnaire("first"));
  const unrelated = await controller.mutate({ action: "put", record: { kind: "globalPreference", preference: { key: "theme", value: "winter" } } });
  assert.deepEqual([unrelated.rows.questionnaireDraftAnswers, unrelated.rows.questionnaireDraftSelections], [[], []]);
  const second = await controller.mutate(questionnaire("second"));
  assert.deepEqual(second.rows.questionnaireDraftAnswers.map(row => row.request_key), ["second"]);
  assert.deepEqual(second.rows.questionnaireDraftSelections.map(row => row.request_key), ["second"]);
  assert.equal(projectedRecords(controller.read()).filter(record => record.kind === "questionnaireDraft").length, 2);
  await controller.close();
});
