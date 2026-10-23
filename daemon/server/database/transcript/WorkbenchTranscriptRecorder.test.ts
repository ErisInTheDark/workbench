/*
 * No production exports. Tests protect ordered forwarding, bounding before settlement and recovery after one rolled-back transcript batch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTranscriptRecorder from "./WorkbenchTranscriptRecorder.ts";
import type { WorkbenchTranscriptObservation } from "./workbench-transcript-types.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};

const observation: WorkbenchTranscriptObservation = {
  kind: "thread",
  threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
  projectId: fixtureIdentityValues.ProjectId["project"],
  projectRoot: "C:/project",
  title: "Thread",
  createdAt: 1,
  updatedAt: 1,
  activityAt: 1,
};

test("oversized item text is bounded before it reaches the database, including inside canonical windows", async () => {
  const settled: WorkbenchTranscriptObservation[] = [];
  const recorder = new WorkbenchTranscriptRecorder({
    settleTranscript: async (observations) => { settled.push(...observations); return { changedThreadIds: [] }; },
  });
  const huge = "y".repeat(5 * 1024 * 1024);
  await recorder.record([{
    kind: "canonicalWindow", contentVersion: 3, materializedTurnIds: [], threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
    observations: [{
      kind: "item", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), lifecycle: "completed", observedAt: 1,
      item: { id: "a", type: "agentMessage", phase: "commentary", text: huge, memoryCitation: null, delivery: null, questions: null },
    }],
  }]);
  const window = settled[0];
  const nested = window?.kind === "canonicalWindow" ? window.observations[0] : undefined;
  assert.ok(nested?.kind === "item" && nested.item.type === "agentMessage");
  assert.ok(nested.item.text.length < huge.length / 2);
});

test("the recorder preserves admitted batch order and retries after one database request failure", async () => {
  const admitted: readonly WorkbenchTranscriptObservation[][] = [];
  const failure = new Error("database failed");
  let calls = 0;
  const recorder = new WorkbenchTranscriptRecorder({
    settleTranscript: async (observations) => {
      calls += 1;
      (admitted as WorkbenchTranscriptObservation[][]).push([...observations]);
      if (calls === 2) throw failure;
      return { changedThreadIds: ["thread"] };
    },
  });

  assert.deepEqual(await recorder.record([observation]), { changedThreadIds: ["thread"] });
  await assert.rejects(recorder.record([{ ...observation, title: "second" }]), (error) => error === failure);
  assert.deepEqual(
    await recorder.record([{ ...observation, title: "third" }]),
    { changedThreadIds: ["thread"] },
  );
  assert.equal(calls, 3);
  assert.deepEqual(
    admitted.map((batch) => batch[0]?.kind === "thread" ? batch[0].title : null),
    ["Thread", "second", "third"],
  );
});
