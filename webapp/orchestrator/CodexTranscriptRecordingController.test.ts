/*
 * No production exports. Tests protect source-owned JSON-first recording and explicit compatibility import. Keywords: codex, transcript, recording, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import CodexTranscriptRecordingController, {
  CodexTranscriptSqliteRecordingFailure,
} from "./CodexTranscriptRecordingController.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types.ts";

const observation: WorkbenchTranscriptObservation = {
  activityAt: 1,
  createdAt: 1,
  kind: "thread",
  projectId: "project",
  projectRoot: "C:/project",
  threadId: "thread",
  title: "Thread",
  updatedAt: 1,
};

test("provider facts and Workbench mutations record JSON before SQLite", async () => {
  const order: string[] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async () => { order.push("sqlite"); },
  });

  await controller.recordProviderFact({
    observations: [observation],
    recordLegacy: async () => { order.push("provider-json"); },
  });
  await controller.recordWorkbenchMutation({
    observations: [observation],
    recordLegacy: async () => { order.push("workbench-json"); },
  });

  assert.deepEqual(order, [
    "provider-json",
    "sqlite",
    "workbench-json",
    "sqlite",
  ]);
});

test("live recording never invokes the compatibility reader", async () => {
  let sqliteWrites = 0;
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async () => { sqliteWrites += 1; },
  });
  const throwingCompatibilityReader = async (): Promise<readonly WorkbenchTranscriptObservation[]> => {
    throw new Error("legacy compatibility reader crossed the live boundary");
  };

  await controller.recordProviderFact({
    observations: [observation],
    recordLegacy: async () => undefined,
  });
  await controller.recordWorkbenchMutation({
    observations: [observation],
    recordLegacy: async () => undefined,
  });
  assert.equal(sqliteWrites, 2);
  await assert.rejects(
    controller.importCompatibilityWindow(throwingCompatibilityReader),
    /crossed the live boundary/u,
  );
  assert.equal(sqliteWrites, 2);
});

test("historical compatibility import records its explicitly loaded window", async () => {
  const batches: readonly WorkbenchTranscriptObservation[][] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async (observations) => {
      (batches as WorkbenchTranscriptObservation[][]).push([...observations]);
    },
  });
  await controller.importCompatibilityWindow(async () => [observation]);
  assert.deepEqual(batches, [[observation]]);
});

test("provider recovery context reaches SQLite after legacy recording", async () => {
  const order: string[] = [];
  const contexts: WorkbenchTranscriptRecordingContext[] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async (_observations, context) => {
      order.push("sqlite");
      contexts.push(context);
    },
  });
  await controller.recordProviderFact({
    observations: [observation],
    recoveryBoundary: true,
    recordLegacy: async () => { order.push("json"); },
  });
  assert.deepEqual(order, ["json", "sqlite"]);
  assert.deepEqual(contexts, [{ recoveryBoundary: true, source: "provider" }]);
});

test("provider facts and crossed Workbench facts settle together as unrecoverable", async () => {
  const order: string[] = [];
  const batches: WorkbenchTranscriptObservation[][] = [];
  const contexts: WorkbenchTranscriptRecordingContext[] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async (observations, context) => {
      order.push("sqlite");
      batches.push([...observations]);
      contexts.push(context);
    },
  });
  const workbenchObservation = { ...observation, updatedAt: 2 };
  await controller.recordProviderFact({
    observations: [observation],
    recordCrossedWorkbenchFacts: async () => {
      order.push("workbench-json");
      return [workbenchObservation];
    },
    recordLegacy: async () => { order.push("provider-json"); },
  });
  assert.deepEqual(order, ["provider-json", "workbench-json", "sqlite"]);
  assert.deepEqual(batches, [[observation, workbenchObservation]]);
  assert.deepEqual(contexts, [{ source: "workbench" }]);
});

test("a Workbench mutation records JSON before reporting SQLite rejection", async () => {
  const order: string[] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async () => {
      order.push("sqlite");
      throw new Error("capture failed");
    },
  });
  await assert.rejects(controller.recordWorkbenchMutation({
    observations: [observation],
    recordLegacy: async () => { order.push("json"); },
  }), (error) => (
    error instanceof CodexTranscriptSqliteRecordingFailure
    && error.message === "capture failed"
  ));
  assert.deepEqual(order, ["json", "sqlite"]);
});

test("a Workbench fact beyond its external boundary still attempts SQLite recording", async () => {
  const order: string[] = [];
  const contexts: WorkbenchTranscriptRecordingContext[] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async (_observations, context) => {
      order.push("sqlite");
      contexts.push(context);
    },
  });
  await controller.recordCrossedWorkbenchMutation({
    observations: [observation],
    recordLegacy: async () => { order.push("json"); },
  });
  assert.deepEqual(order, ["json", "sqlite"]);
  assert.deepEqual(contexts, [{ source: "workbench" }]);
});

test("SQLite rejection remains distinct from source-owned legacy failure", async () => {
  let legacyRecorded = false;
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async () => { throw new Error("sqlite failed"); },
  });
  await assert.rejects(controller.recordProviderFact({
    observations: [observation],
    recordLegacy: async () => { legacyRecorded = true; },
  }), (error) => (
    error instanceof CodexTranscriptSqliteRecordingFailure
    && error.message === "sqlite failed"
  ));
  assert.equal(legacyRecorded, true);
});
