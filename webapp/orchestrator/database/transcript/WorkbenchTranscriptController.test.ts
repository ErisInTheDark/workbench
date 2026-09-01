/*
 * No production exports. Tests protect the worker-backed transcript lifecycle from readiness through reactive settlement and disposal. Keywords: transcript, controller, worker, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptController from "./WorkbenchTranscriptController.ts";

test("the transcript controller records, reads, refreshes, and stops admitting work after disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-controller-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  const controller = new WorkbenchTranscriptController(database);
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
    }]);

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
    }]);
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
    await assert.rejects(controller.read({ threadId: "thread", turnLimit: 10 }), /disposed/);
  } finally {
    controller.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
