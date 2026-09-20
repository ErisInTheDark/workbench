/*
 * No production exports. Tests protect stored OpenCode steer history projection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../../database/workbench-database-schema";
import WorkbenchTranscriptRepository from "../../database/transcript/WorkbenchTranscriptRepository";
import OpenCodeTranscriptReader from "./OpenCodeTranscriptReader";

test("projects delivered OpenCode steers as transcript items and steer history", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const itemId = WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000003");
  try {
    repository.settle([{
      kind: "thread",
      threadId,
      projectId: testProjectIds.project,
      projectRoot: "C:/repo",
      title: "OpenCode",
      createdAt: 1,
      updatedAt: 3,
      activityAt: 3,
    }, {
      kind: "turn",
      threadId,
      turnId,
      turnIndex: 0,
      harnessId: "opencode",
      nativeLocation: "C:/repo",
      nativeThreadId: NativeThreadIdSchema.parse("native-thread"),
      nativeTurnId: NativeTurnIdSchema.parse("native-turn"),
      state: "inProgress",
      createdAt: 1,
      startedAt: 1,
      endedAt: null,
      durationMs: null,
    }, {
      kind: "steer",
      observedAt: 3,
      entry: {
        threadId,
        turnId,
        itemId,
        entryKey: itemId,
        input: [{ type: "text", text: "change course", text_elements: [] }],
        status: "sent",
        attemptedAt: 2,
        resolvedAt: 3,
        requestId: null,
        canonicalItemId: itemId,
        clientUserMessageId: "00000000-0000-4000-8000-000000000004",
        error: null,
      },
    }, {
      kind: "threadContextUsage",
      threadId,
      initialise: false,
      snapshot: {
        tokenUsage: {
          last: {
            cacheWriteInputTokens: 0, cachedInputTokens: 10, inputTokens: 100,
            outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 125,
          },
          total: {
            cacheWriteInputTokens: 0, cachedInputTokens: 10, inputTokens: 100,
            outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 125,
          },
          modelContextWindow: 200_000,
        },
      },
    }]);

    const reader = new OpenCodeTranscriptReader(
      request => Promise.resolve(repository.read(request)),
      id => Promise.resolve(repository.readContextUsage(id)),
    );
    const page = await reader.readPage({ threadId, cursor: null }, null);
    const item = page?.thread.turns[0]?.items[0];
    assert.ok(item);
    assert.deepEqual(getWorkbenchInputState(item), { kind: "steer", status: "sent" });
    assert.deepEqual(page?.steerEntries.map(entry => ({
      canonicalItemId: entry.canonicalItemId,
      clientUserMessageId: entry.clientUserMessageId,
      itemId: entry.itemId,
      status: entry.status,
    })), [{
      canonicalItemId: item.id,
      clientUserMessageId: "00000000-0000-4000-8000-000000000004",
      itemId: item.id,
      status: "sent",
    }]);
    assert.equal(page?.thread.tokenUsage?.modelContextWindow, 200_000);
  } finally {
    database.close();
  }
});
