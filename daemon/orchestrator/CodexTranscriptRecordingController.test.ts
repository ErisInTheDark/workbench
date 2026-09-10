/*
 * No production exports. Tests protect source-owned JSON-first recording and explicit compatibility import.
 */
import assert from "node:assert/strict";
import test from "node:test";

import CodexTranscriptRecordingController, {
  CodexTranscriptSqliteRecordingFailure,
} from "./CodexTranscriptRecordingController.ts";
import type {
  NativeTranscriptObservation,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
};

const observation: NativeTranscriptObservation = {
  activityAt: 1,
  createdAt: 1,
  kind: "thread",
  projectId: fixtureIdentityValues.ProjectId["project"],
  projectRoot: "C:/project",
  threadId: fixtureIdentityValues.NativeThreadId["thread"],
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
  const throwingCompatibilityReader = async (): Promise<readonly NativeTranscriptObservation[]> => {
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
  const batches: NativeTranscriptObservation[][] = [];
  const controller = new CodexTranscriptRecordingController({
    recordSqlite: async (observations) => {
      batches.push([...observations]);
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
  const batches: NativeTranscriptObservation[][] = [];
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
