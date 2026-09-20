/*
 * No production exports. Protect SQL window selection and interaction projection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptAtomicObservation } from "./database/transcript/workbench-transcript-types";
import CodexStoredTranscriptAdapter from "./CodexStoredTranscriptAdapter";
import WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

test("SQL reads select the exact window and retain answered interactions without reading unrelated bodies", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const threadId = WorkbenchThreadIdSchema.parse("reader-thread");
  const older = WorkbenchTurnIdSchema.parse("older");
  const newer = WorkbenchTurnIdSchema.parse("newer");
  const observations: WorkbenchTranscriptAtomicObservation[] = [{
    kind: "thread", threadId, projectId: testProjectIds.project, projectRoot: "/repo",
    title: "reader", createdAt: 1, updatedAt: 5, activityAt: 5,
  }];
  for (const [index, turnId] of [older, newer].entries()) {
    observations.push({
      kind: "turn", threadId, turnId, turnIndex: index, harnessId: "codex",
      nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("provider-thread"),
      nativeTurnId: NativeTurnIdSchema.parse(`provider-${turnId}`), state: "completed",
      createdAt: index + 1, startedAt: index + 1, endedAt: index + 2, durationMs: 1,
    }, {
      kind: "item", threadId, turnId, observedAt: index + 2, lifecycle: "completed",
      item: { id: `message-${index}`, type: "agentMessage", text: `reply ${index}`,
        phase: "commentary", memoryCitation: null, delivery: null, questions: null },
    });
  }
  observations.push({
    kind: "item", threadId, turnId: newer, observedAt: 5, lifecycle: "completed",
    item: {
      id: "blocked-change", type: "fileChange", status: "failed", workbenchFailureKind: "unclaimed",
      changes: [{
        path: "src/blocked.ts", diff: "", kind: { type: "update", move_path: null },
        workbenchAdditions: 2, workbenchDeletions: 1,
      }],
    },
  });
  const request = {
    id: "question", title: "", summary: "", submitLabel: "",
    questions: [{ id: "choice", header: "", question: "continue?", options: [], allowOther: false, isSecret: false }],
  };
  observations.push({
    kind: "questionnaire", observedAt: 3,
    entry: { requestKey: "question", threadId, turnId: older, itemId: "question-item",
      request, response: { answers: { choice: { answers: ["yes"] } } }, resolvedAt: 3,
      insertAfterItemId: "message-0", insertAfterItemIndex: 0 },
  }, {
    kind: "steer", observedAt: 4,
    entry: { threadId, turnId: older, entryKey: "steer", input: [{ type: "text", text: "retry", text_elements: [] }],
      status: "interrupted", attemptedAt: 3, resolvedAt: 4, requestId: null, canonicalItemId: null, error: null },
  });
  try {
    repository.settle([{ kind: "canonicalWindow", threadId, contentVersion: 3,
      materializedTurnIds: [older, newer], observations }]);
    const stored = repository.read({ threadId, turnLimit: 2 });
    assert.ok(stored);
    const firstMessageId = stored.rows.itemSourceAliases
      .find(({ reference }) => reference === "message-0")?.item_identity_id;
    assert.ok(firstMessageId);
    const canonical = new WorkbenchTranscriptReader({
      readSnapshot: async input => repository.read(input), readContext: async id => repository.readContext(id),
      readMaterializedTurns: async (id, turns) => repository.readMaterializedTurnIds(id, turns),
      readContextUsage: async id => repository.readContextUsage(id),
      readMetadata: async () => ({ entry: null, harness: "codex" }),
    });
    const reader = new CodexStoredTranscriptAdapter(canonical);
    const metadata: Thread = {
      id: threadId, turns: [], extra: null, sessionId: "session", forkedFromId: null,
      parentThreadId: null, historyMode: "legacy", projectId: null, preview: "", ephemeral: false,
      modelProvider: "openai", model: null, reasoningEffort: null, createdAt: 1, updatedAt: 5,
      recencyAt: null, status: { type: "idle" }, path: null, cwd: "/repo", cliVersion: "test",
      source: "appServer", threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: null, canAcceptDirectInput: null, section: null, sectionEnteredAt: null,
    };
    const latest = await reader.read(metadata, { mode: "latest" });
    assert.deepEqual(latest?.thread.turns.map(turn => turn.id), [newer]);
    assert.deepEqual(latest?.questionnaireEntries, []);
    const previous = await reader.read(metadata, { mode: "previous", beforeTurnId: "provider-newer" });
    assert.deepEqual(previous?.thread.turns.map(turn => turn.id), [older]);
    assert.deepEqual(previous?.questionnaireEntries[0]?.response, { answers: { choice: { answers: ["yes"] } } });
    assert.equal(previous?.questionnaireEntries[0]?.insertAfterItemId, firstMessageId);
    assert.equal(previous?.steerEntries[0]?.status, "interrupted");
    const history = await reader.history(threadId);
    assert.equal(history.questionnaireEntries.length, 1);
    assert.equal(history.questionnaireEntries[0]?.insertAfterItemId, previous?.questionnaireEntries[0]?.insertAfterItemId);
    assert.equal(history.steerEntries.length, 1);
    assert.deepEqual(repository.readContext(threadId)?.rows.threadItemAssistantMessages, []);
    assert.equal(await reader.read(metadata, { mode: "previous", beforeTurnId: "not-known" }), null);
    const blocked = await reader.readFileChange(threadId, NativeTurnIdSchema.parse("provider-newer"), "blocked-change");
    assert.equal(blocked?.workbenchFailureKind, "unclaimed");
    assert.deepEqual(blocked?.changes.map(change => ({
      path: change.path,
      additions: change.workbenchAdditions,
      deletions: change.workbenchDeletions,
    })), [{ path: "src/blocked.ts", additions: 2, deletions: 1 }]);
    assert.equal(await reader.readFileChange(threadId, newer, "message-1"), null);
    assert.equal(await reader.readFileChange(threadId, newer, "missing"), null);
  } finally { database.close(); }
});
