/*
 * No production exports. Tests protect source-owned JSON-first recording and explicit compatibility import. Keywords: codex, transcript, recording, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import CodexTranscriptRecordingController from "./CodexTranscriptRecordingController.ts";
import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types.ts";

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
