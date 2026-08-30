/* No production exports. Real SQLite wards protect revisioned app-state mutation, profile replacement, and structured draft hydration. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import type { WorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state";

import WorkbenchAppStateController from "./WorkbenchAppStateController.ts";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";

function projectedRecords(response: WorkbenchClientStateResponse) {
  return projectWorkbenchClientStateRows(response.rows).flatMap((change) => (
    change.change === "upsert" ? [change.record] : []
  ));
}

async function controllerFixture(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-controller-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const databasePath = path.join(directory, "state.sqlite3");
  const create = () => new WorkbenchAppStateController(new WorkbenchAppStateRepository({ databasePath }));
  const controller = create();
  const daemonRegistrationId = controller.start();
  return { controller, create, daemonRegistrationId };
}

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
  fixture.controller.close();

  const restarted = fixture.create();
  restarted.start();
  const snapshot = restarted.read();
  assert.ok(snapshot.kind === "snapshot" && projectedRecords(snapshot).some((record) => (
    record.kind === "globalPreference"
    && record.preference.key === "theme"
    && record.preference.value === "winter"
  )));
  restarted.close();
});

test("a future revision receives a complete snapshot instead of an invalid delta", async (context) => {
  const { controller } = await controllerFixture(context);
  const response = controller.read(Number.MAX_SAFE_INTEGER);
  assert.equal(response.kind, "snapshot");
  controller.close();
});

test("profile choices replace custom settings with a daemon-owned profile reference", async (context) => {
  const { controller, daemonRegistrationId } = await controllerFixture(context);
  await controller.mutate({
    action: "put",
    record: {
      daemonRegistrationId,
      kind: "newThreadProfilePreference",
      projectId: "project",
      value: {
        kind: "custom",
        settings: {
          agentPath: null,
          agentSource: null,
          harness: "codex",
          model: "model",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
      },
    },
  });
  await controller.mutate({
    action: "put",
    record: {
      daemonRegistrationId,
      kind: "newThreadProfilePreference",
      projectId: "project",
      value: { kind: "daemon-profile", profileId: "profile-id" },
    },
  });
  const snapshot = controller.read();
  assert.ok(snapshot.kind === "snapshot" && projectedRecords(snapshot).some((record) => (
    record.kind === "newThreadProfilePreference"
    && record.value.kind === "daemon-profile"
    && record.value.profileId === "profile-id"
  )));
  controller.close();
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
  controller.close();
});
