/*
 * No production exports. Tests protect ordered forwarding and recovery after one rolled-back transcript batch. Keywords: transcript, recorder, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTranscriptRecorder from "./WorkbenchTranscriptRecorder.ts";
import type { WorkbenchTranscriptObservation } from "./workbench-transcript-types.ts";

const observation: WorkbenchTranscriptObservation = {
  kind: "thread",
  threadId: "thread",
  projectId: "project",
  projectRoot: "C:/project",
  title: "Thread",
  createdAt: 1,
  updatedAt: 1,
  activityAt: 1,
};

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
