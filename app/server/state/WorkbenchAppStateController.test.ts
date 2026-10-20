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

test("file draft undo history survives saves, deltas and restart, and leaves with its draft", async context => {
  const fixture = await controllerFixture(context);
  const identity = { kind: "fileDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId,
    projectId: "project", path: "icon.svg" };
  const history = { currentIndex: 1, frames: [
    { kind: "snapshot" as const, content: "<svg/>", timestamp: 1 },
    { kind: "patch" as const, start: 4, deletedText: "/", insertedText: "><path/></svg", timestamp: 2 },
    { kind: "patch" as const, start: 10, deletedText: "", insertedText: " d=\"M0 0\"", timestamp: 3 },
  ] };
  const value = { baselineContent: "<svg/>", content: "<svg><path/></svg>", expectedMtimeMs: 7,
    headContent: null, mode: "plain" as const };
  const read = (response: WorkbenchClientStateResponse) => projectedRecords(response).find(record => record.kind === "fileDraft");
  try {
    const saved = await fixture.controller.mutate({ action: "put", record: { ...identity, value: { ...value, history } } });
    assert.equal(conformWorkbenchClientStateResponse(saved).success, true);
    assert.deepEqual(read(saved), { ...identity, value: { ...value, history } });
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(read(restarted.read()), { ...identity, value: { ...value, history } });
    // A save without history (an older client) must not leave history describing other content.
    await restarted.mutate({ action: "put", record: { ...identity, value } });
    assert.deepEqual(read(restarted.read()), { ...identity, value });
    await restarted.mutate({ action: "put", record: { ...identity, value: { ...value, history } } });
    await restarted.mutate({ action: "delete", identity });
    assert.equal(read(restarted.read()), undefined);
  } finally { await restarted.close(); }
});

test("composer attachments preserve supplied order through unchanged URLs, uploads and reopen", async context => {
  const fixture = await controllerFixture(context);
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: fixture.daemonRegistrationId,
    projectId: "project", threadId: "thread" };
  const attachments = ["z-first", "a-second", "m-third"].map(id => ({ id, url: `image:${id}` }));
  const read = (controller: WorkbenchAppStateController) => {
    const record = projectedRecords(controller.read()).find(item => item.kind === "composerDraft");
    return record?.kind === "composerDraft" ? record.value.attachments.map(item => item.id) : [];
  };
  try {
    await fixture.controller.mutate({ action: "put", record: {
      ...identity, value: { text: "images", attachments, updatedAt: 1 },
    } });
    assert.deepEqual(read(fixture.controller), attachments.map(item => item.id));
    await fixture.controller.mutate({ action: "put", record: {
      ...identity, value: { text: "images", attachments: attachments.slice(1), updatedAt: 2 },
    } });
    await fixture.controller.putAttachment(identity, "b-fourth", "image/png", new Uint8Array([1]));
    await fixture.controller.putAttachment(identity, "a-second", "image/png", new Uint8Array([2]));
    assert.deepEqual(read(fixture.controller), ["a-second", "m-third", "b-fourth"]);
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(read(restarted), ["a-second", "m-third", "b-fourth"]);
  } finally { await restarted.close(); }
});

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

test("mark tag lists keep their order and colours, replace whole, ride deltas and clear with their owner", async context => {
  const fixture = await controllerFixture(context);
  const logicalProjectId = LogicalProjectIdSchema.parse("84c24145-0460-489c-ac05-b382b38d4b12");
  const global = (value: Array<{ color: "red" | "green" | "blue"; name: string }>) => ({
    kind: "globalPreference" as const, preference: { key: "markTags" as const, value },
  });
  const project = (value: Array<{ color: "red" | "green" | "blue"; name: string }>) => ({
    kind: "logicalProjectPreference" as const, logicalProjectId, preference: { enabled: true, key: "markTags" as const, value },
  });
  const tags = (response: WorkbenchClientStateResponse) => projectedRecords(response).flatMap(record =>
    (record.kind === "globalPreference" || record.kind === "logicalProjectPreference") && record.preference.key === "markTags"
      ? [record] : []).sort((left, right) => left.kind.localeCompare(right.kind));
  try {
    const saved = await fixture.controller.mutate({ action: "put", record: global([{ color: "green", name: "good" }, { color: "red", name: "bad" }]) });
    assert.equal(conformWorkbenchClientStateResponse(saved).success, true);
    assert.deepEqual(tags(saved), [global([{ color: "green", name: "good" }, { color: "red", name: "bad" }])], "the acknowledgement delta carries the list");
    await fixture.controller.mutate({ action: "put", record: global([{ color: "red", name: "bad" }]) });
    await fixture.controller.mutate({ action: "put", record: project([{ color: "blue", name: "later" }, { color: "red", name: "bad" }]) });
    const untouched = fixture.controller.revision;
    await fixture.controller.mutate({ action: "put", record: { kind: "globalPreference", preference: { key: "theme", value: "winter" } } });
    assert.deepEqual(tags(fixture.controller.read(untouched)), [], "unchanged lists stay out of later deltas");
    await fixture.controller.mutate({ action: "put", record: global([]) });
    assert.deepEqual(tags(fixture.controller.read()), [global([]), project([{ color: "blue", name: "later" }, { color: "red", name: "bad" }])],
      "an emptied list is still the user's list");
  } finally { await fixture.controller.close(); }
  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(tags(restarted.read()), [global([]), project([{ color: "blue", name: "later" }, { color: "red", name: "bad" }])]);
    await restarted.mutate({ action: "delete", identity: { kind: "logicalProjectPreference", logicalProjectId, key: "markTags" } });
    assert.deepEqual(tags(restarted.read()), [global([])]);
    await restarted.mutate({ action: "put", record: project([{ color: "green", name: "good" }]) });
    await restarted.forgetLogicalProjects(new Set());
    assert.deepEqual(tags(restarted.read()), [global([])], "a gone project's override leaves with its tags");
    await restarted.mutate({ action: "put", record: project([{ color: "green", name: "good" }]) });
    assert.deepEqual(tags(restarted.read()), [global([]), project([{ color: "green", name: "good" }])], "no stale tags return with a new override");
  } finally { await restarted.close(); }
});

test("last project selection preserves order and replaces explicit, empty and unfiltered states", async context => {
  const fixture = await controllerFixture(context);
  const first = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const second = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const selection = () => projectedRecords(fixture.controller.read())
    .find(record => record.kind === "lastProjectSelection");
  try {
    await fixture.controller.mutate({
      action: "put",
      record: { kind: "lastProjectSelection", selectedProjectIds: [second, first] },
    });
    assert.deepEqual(selection()?.selectedProjectIds, [second, first]);

    await fixture.controller.mutate({
      action: "put",
      record: { kind: "lastProjectSelection", selectedProjectIds: [] },
    });
    assert.deepEqual(selection()?.selectedProjectIds, []);

    await fixture.controller.mutate({
      action: "put",
      record: { kind: "lastProjectSelection", selectedProjectIds: null },
    });
    assert.equal(selection()?.selectedProjectIds, null);

    await fixture.controller.mutate({
      action: "put",
      record: { kind: "lastProjectSelection", selectedProjectIds: [first] },
    });
  } finally { await fixture.controller.close(); }

  const restarted = fixture.create();
  try {
    await restarted.start();
    assert.deepEqual(projectedRecords(restarted.read())
      .find(record => record.kind === "lastProjectSelection")?.selectedProjectIds, [first]);
  } finally { await restarted.close(); }
});

test("forgetting gone logical projects deletes their preferences and drops them from the saved selection", async context => {
  const fixture = await controllerFixture(context);
  const live = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const gone = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const preference = (logicalProjectId: typeof live) => ({
    kind: "logicalProjectPreference" as const, logicalProjectId,
    preference: { enabled: true, key: "theme", value: "winter" } as const,
  });
  try {
    await fixture.controller.mutate({ action: "put", record: preference(live) });
    await fixture.controller.mutate({ action: "put", record: preference(gone) });
    await fixture.controller.mutate({ action: "put", record: { kind: "lastProjectSelection", selectedProjectIds: [gone, live] } });
    const before = fixture.controller.revision;
    await fixture.controller.forgetLogicalProjects(new Set([live]));
    const records = projectedRecords(fixture.controller.read());
    assert.deepEqual(records.filter(record => record.kind === "logicalProjectPreference"), [preference(live)]);
    assert.deepEqual(records.find(record => record.kind === "lastProjectSelection")?.selectedProjectIds, [live]);
    const settled = fixture.controller.revision;
    assert.ok(settled > before);
    await fixture.controller.forgetLogicalProjects(new Set([live]));
    assert.equal(fixture.controller.revision, settled, "nothing left to forget commits nothing");
  } finally { await fixture.controller.close(); }
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
  await controller.mutate({
    action: "put",
    record: {
      daemonRegistrationId,
      kind: "composerDraft",
      projectId: "project",
      threadId: "other-thread",
      value: { attachments: [{ id: "other", url: "asset://other" }, { id: "second", url: "asset://second" }], text: "other", updatedAt: 30 },
    },
  });
  const snapshot = controller.read();
  const records = projectedRecords(snapshot);
  assert.equal(snapshot.kind, "snapshot");
  assert.deepEqual(records.flatMap(record => record.kind === "composerDraft"
    ? [[record.threadId, record.value.attachments.map(attachment => attachment.url)]] : []).sort(), [
    ["other-thread", ["asset://other", "asset://second"]],
    ["thread", ["asset://image"]],
  ]);
  assert.ok(snapshot.kind === "snapshot" && records.some((record) => (
    record.kind === "questionnaireDraft"
    && record.value.customValues.question === "custom"
    && record.value.selectedValues.choice?.length === 2
  )));
  await controller.close();
});

test("full reads leave deletion tombstones out while deltas still carry them", async (context) => {
  const { controller, daemonRegistrationId } = await controllerFixture(context);
  const identity = { daemonRegistrationId, kind: "composerDraft" as const, projectId: "project", threadId: "gone" };
  const created = await controller.mutate({ action: "put", record: { ...identity, value: { attachments: [], text: "draft", updatedAt: 1 } } });
  await controller.mutate({ action: "delete", identity });
  const drafts = (response: WorkbenchClientStateResponse) => response.rows.composerDrafts.filter(row => row.thread_id === "gone");
  assert.deepEqual(drafts(controller.read()), []);
  assert.deepEqual(drafts(controller.read(created.revision)).map(row => row.deleted), [1]);
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
