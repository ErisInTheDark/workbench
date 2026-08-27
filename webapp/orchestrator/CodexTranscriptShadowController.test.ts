/*
 * No production exports. Tests protect latest-only batching and disposal isolation for Codex SQLite shadow work. Keywords: codex, transcript, shadow, lifecycle.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types";
import CodexTranscriptShadowController from "./CodexTranscriptShadowController";

function threadObservation(title: string): WorkbenchTranscriptObservation {
  return {
    activityAt: 1,
    createdAt: 1,
    kind: "thread",
    projectId: "project",
    projectRoot: "C:/project",
    threadId: "thread",
    title,
    updatedAt: 1,
  };
}

async function settleMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("shadow jobs batch per thread, replace stale keys, and retain only one later flush", async () => {
  const scheduled: (() => void)[] = [];
  const recorded: WorkbenchTranscriptObservation[][] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = new CodexTranscriptShadowController({
    record: async (observations) => {
      recorded.push([...observations]);
      if (recorded.length === 1) await firstBlocked;
    },
    scheduleFlush: (flush) => {
      scheduled.push(flush);
      return () => undefined;
    },
  });

  for (let index = 0; index < 1_000; index += 1) {
    controller.schedule({
      key: "item",
      load: async () => [threadObservation(`before-${index}`)],
      threadId: "thread",
    });
  }
  controller.schedule({
    key: "turn",
    load: async () => [threadObservation("turn")],
    threadId: "thread",
  });
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await settleMicrotasks();
  assert.deepEqual(recorded[0]?.map((observation) => (
    observation.kind === "thread" ? observation.title : observation.kind
  )), ["before-999", "turn"]);

  for (let index = 0; index < 1_000; index += 1) {
    controller.schedule({
      key: "item",
      load: async () => [threadObservation(`after-${index}`)],
      threadId: "thread",
    });
  }
  assert.equal(scheduled.length, 0);
  releaseFirst();
  await settleMicrotasks();
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await settleMicrotasks();
  assert.deepEqual(recorded[1]?.map((observation) => (
    observation.kind === "thread" ? observation.title : observation.kind
  )), ["after-999"]);
});

test("dispose cancels pending work and does not wait for an active shadow flush", async () => {
  const scheduled: (() => void)[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let recordCount = 0;
  const controller = new CodexTranscriptShadowController({
    record: async () => {
      recordCount += 1;
      await blocked;
    },
    scheduleFlush: (flush) => {
      scheduled.push(flush);
      return () => undefined;
    },
  });

  controller.schedule({
    key: "active",
    load: async () => [threadObservation("active")],
    threadId: "thread",
  });
  scheduled.shift()?.();
  await settleMicrotasks();
  controller.schedule({
    key: "pending",
    load: async () => [threadObservation("pending")],
    threadId: "thread",
  });

  controller.dispose();
  assert.equal(recordCount, 1);
  release();
  await settleMicrotasks();
  assert.equal(recordCount, 1);
});
