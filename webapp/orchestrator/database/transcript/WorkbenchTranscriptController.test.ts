/*
 * No production exports. Tests protect transcript readiness, direct shadow recording, per-thread gap isolation, recovery, subscriptions, and disposal. Keywords: transcript, controller, recovery, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptCaptureGapController from "./WorkbenchTranscriptCaptureGapController.ts";
import WorkbenchTranscriptController from "./WorkbenchTranscriptController.ts";
import type { WorkbenchTranscriptObservation } from "./workbench-transcript-types.ts";

function observationsFor(threadId: string): WorkbenchTranscriptObservation[] {
  return [{
    activityAt: 1,
    createdAt: 1,
    kind: "thread",
    projectId: "project",
    projectRoot: "C:/project",
    threadId,
    title: `Thread ${threadId}`,
    updatedAt: 1,
  }, {
    createdAt: 2,
    durationMs: null,
    endedAt: null,
    harnessId: "codex",
    kind: "turn",
    nativeLocation: "C:/project",
    nativeThreadId: threadId,
    nativeTurnId: `turn-${threadId}`,
    startedAt: 2,
    state: "inProgress",
    threadId,
    turnId: `turn-${threadId}`,
    turnIndex: 0,
  }];
}

test("the transcript controller records, reads, refreshes, and stops admitting work after disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-controller-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  const controller = new WorkbenchTranscriptController(
    database,
    new WorkbenchTranscriptCaptureGapController({
      markerPath: join(directory, "capture-gap.json"),
    }),
  );
  try {
    await controller.start();
    await controller.record([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: ["turn"],
      threadId: "thread",
      observations: [
        {
          kind: "thread",
          threadId: "thread",
          projectId: "project",
          projectRoot: "C:/project",
          title: "Thread",
          createdAt: 1,
          updatedAt: 1,
          activityAt: 1,
        },
        {
          kind: "turn",
          threadId: "thread",
          turnId: "turn",
          turnIndex: 0,
          harnessId: "codex",
          nativeLocation: "C:/project",
          nativeThreadId: "native",
          nativeTurnId: "turn",
          state: "inProgress",
          createdAt: 2,
          startedAt: 2,
          endedAt: null,
          durationMs: null,
        },
      ],
    }], { source: "compatibility" });

    const published: number[] = [];
    await controller.subscribe({
      id: "latest",
      request: { threadId: "thread", turnLimit: 10 },
      publish: (snapshot) => {
        published.push(snapshot?.rows.threadItems.length ?? -1);
      },
    });
    await controller.record([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: ["turn"],
      threadId: "thread",
      observations: [{
        kind: "thread",
        threadId: "thread",
        projectId: "project",
        projectRoot: "C:/project",
        title: "Thread",
        createdAt: 1,
        updatedAt: 3,
        activityAt: 3,
      }, {
        kind: "turn",
        threadId: "thread",
        turnId: "turn",
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: "native",
        nativeTurnId: "turn",
        state: "inProgress",
        createdAt: 2,
        startedAt: 2,
        endedAt: null,
        durationMs: null,
      }, {
        kind: "item",
        threadId: "thread",
        turnId: "turn",
        lifecycle: "completed",
        observedAt: 3,
        item: {
          type: "agentMessage",
          id: "message",
          text: "hello",
          phase: "final_answer",
          memoryCitation: null,
        },
      }],
    }], { source: "compatibility" });
    assert.deepEqual(published, [0, 1]);
    const snapshot = await controller.read({ threadId: "thread", turnLimit: 10 });
    const messageItemId = snapshot?.rows.threadItems.find(({ source_id }) => source_id === "message")?.id;
    assert.ok(messageItemId);
    assert.deepEqual(
      snapshot?.rows.threadItemAssistantMessages,
      [{
        item_id: messageItemId,
        item_type: "assistantMessage",
        state: "completed",
        phase: "finalAnswer",
        text: "hello",
      }],
    );

    controller.dispose();
    await assert.rejects(controller.read({ threadId: "thread", turnLimit: 10 }), /disposed/u);
  } finally {
    controller.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture gaps block only per-thread compatibility and cutover while direct recording continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-controller-gap-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const markerPath = join(directory, "capture-gap.json");
  let database = new WorkbenchDatabaseController({ databasePath });
  let rejectSettlements = true;
  const failed = new WorkbenchTranscriptController({
    get failure() { return database.failure; },
    readTranscript: (request) => database.readTranscript(request),
    settleTranscript: (observations) => (
      rejectSettlements
        ? Promise.reject(new Error("settlement failed"))
        : database.settleTranscript(observations)
    ),
    start: () => database.start(),
  }, new WorkbenchTranscriptCaptureGapController({
    markerPath,
    now: () => 10,
    randomId: (() => {
      const ids = ["gap-provider", "gap-workbench"][Symbol.iterator]();
      return () => ids.next().value!;
    })(),
  }));
  let recovered: WorkbenchTranscriptController | null = null;
  try {
    await failed.start();
    await assert.rejects(
      failed.record(observationsFor("provider-thread"), { source: "provider" }),
      /shadow settlement failed/u,
    );
    await assert.rejects(
      failed.record(observationsFor("workbench-thread"), { source: "workbench" }),
      /shadow settlement failed/u,
    );
    failed.assertReady();
    assert.throws(() => failed.assertCutoverReady(), /capture gaps for 2 thread/u);
    assert.deepEqual(failed.pendingRecoveryThreadIds, ["provider-thread"]);

    rejectSettlements = false;
    await failed.record(observationsFor("provider-thread"), { source: "provider" });
    await failed.record(observationsFor("workbench-thread"), { source: "workbench" });
    assert.equal(
      (await failed.read({ threadId: "workbench-thread", turnLimit: 1 }))?.thread.id,
      "workbench-thread",
    );
    await assert.rejects(
      failed.record(observationsFor("provider-thread"), { source: "compatibility" }),
      /compatibility import is disabled for gapped thread/u,
    );
    await failed.record(observationsFor("clean-thread"), { source: "compatibility" });

    failed.dispose();
    await database.close();
    database = new WorkbenchDatabaseController({ databasePath });
    recovered = new WorkbenchTranscriptController(
      database,
      new WorkbenchTranscriptCaptureGapController({ markerPath, now: () => 20 }),
    );
    await recovered.start();
    recovered.assertReady();
    assert.deepEqual(recovered.pendingRecoveryThreadIds, ["provider-thread"]);
    await recovered.record(
      observationsFor("provider-thread"),
      { recoveryBoundary: true, source: "provider" },
    );
    assert.deepEqual(recovered.pendingRecoveryThreadIds, []);
    assert.throws(() => recovered!.assertCutoverReady(), /capture gaps for 1 thread/u);

    await recovered.record(observationsFor("workbench-thread"), { source: "workbench" });
    assert.equal(
      (await recovered.read({ threadId: "workbench-thread", turnLimit: 1 }))?.thread.id,
      "workbench-thread",
    );
  } finally {
    failed.dispose();
    recovered?.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
