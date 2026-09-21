/*
 * No production exports. Protect provider-independent canonical paging and gap failures.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

test("canonical pages traverse mixed-provider turns without provider reads", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const threadId = WorkbenchThreadIdSchema.parse("mixed-thread");
  const turns = ["oldest", "middle", "latest"].map(id => WorkbenchTurnIdSchema.parse(id));
  repository.settle([{
    kind: "thread", threadId, projectId: testProjectIds.project, projectRoot: "/repo",
    title: "mixed", createdAt: 1, updatedAt: 4, activityAt: 4,
  }, ...turns.flatMap((turnId, index) => [{
    kind: "turn" as const, threadId, turnId, turnIndex: index,
    harnessId: index === 1 ? "opencode" : "codex",
    nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse(`native-${index}`),
    nativeTurnId: NativeTurnIdSchema.parse(`turn-${index}`), state: "completed" as const,
    createdAt: index + 1, startedAt: index + 1, endedAt: index + 2, durationMs: 1,
  }, {
    kind: "item" as const, threadId, turnId, observedAt: index + 2, lifecycle: "completed" as const,
    item: { id: `item-${index}`, type: "agentMessage" as const, text: `reply ${index}`,
      phase: "commentary" as const, memoryCitation: null, delivery: null, questions: null },
  }])]);
  const reader = new WorkbenchTranscriptReader({
    readProviderCursor: async (id, turnId) => repository.readProviderPreviousCursor(id, turnId),
    readSnapshot: async request => repository.read(request),
    readContext: async id => repository.readContext(id),
    readMaterializedTurns: async (id, ids) => repository.readMaterializedTurnIds(id, ids),
    readContextUsage: async id => repository.readContextUsage(id),
    readMetadata: async () => ({
      harness: "codex",
      entry: {
        entryKind: "thread", title: "current title", activityAt: 4,
        identity: { kind: "thread", projectId: testProjectIds.project, threadId, harness: "codex" },
        lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "question", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false },
        profile: { kind: "custom", settings: {
          harness: "codex", model: "current-model", reasoningEffort: "low",
          serviceTier: "fast", agentPath: "agent://current.md", agentSource: "project",
        } },
      },
    }),
  });
  try {
    let cursor: string | null = null;
    for (const expected of [...turns].reverse()) {
      const page = await reader.readPage({ threadId, cursor });
      assert.deepEqual(page.thread.turns.map(turn => turn.id), [expected]);
      assert.deepEqual(page.thread.turnHistory.map(turn => turn.turnId), turns);
      assert.equal(page.thread.model, "current-model");
      assert.equal(page.thread.reasoningEffort, "low");
      assert.equal(page.thread.status, "active:waitingOnUserInput");
      cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    const unknown = await reader.readPage({ threadId, cursor: turns[0]!, recoveryAware: true });
    assert.deepEqual(unknown.recovery, { mode: "previous", beforeTurnId: turns[0] });
    repository.settle([{ kind: "providerCursor", threadId, turnId: turns[0]!, previousCursor: null }]);
    const exhausted = await reader.readPage({ threadId, cursor: turns[0]!, recoveryAware: true });
    assert.equal(exhausted.recovery, null);
    assert.equal(exhausted.nextCursor, null);
    assert.deepEqual(exhausted.thread.turns, []);
    await assert.rejects(reader.readPage({ threadId, cursor: "foreign" }), /boundary/iu);
    database.prepare("DELETE FROM thread_turn_materializations WHERE turn_id = ?").run(turns[2]);
    const bestAvailable = await reader.readPage({ threadId, cursor: null });
    assert.deepEqual(bestAvailable.thread.turns.map(turn => turn.id), [turns[1]]);
    assert.deepEqual(bestAvailable.thread.turnHistory.map(turn => turn.turnId), turns);
    database.prepare("DELETE FROM thread_turn_materializations WHERE turn_id = ?").run(turns[1]);
    const missing = await reader.readPage({ threadId, cursor: turns[2]!, recoveryAware: true });
    assert.deepEqual(missing.thread.turns, []);
    assert.deepEqual(missing.recovery, { mode: "previous", beforeTurnId: turns[2] });
  } finally {
    database.close();
  }
});

test("empty canonical history and retained interaction facts need no provider interpretation", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const threadId = WorkbenchThreadIdSchema.parse("interactions");
  const turnId = WorkbenchTurnIdSchema.parse("turn");
  repository.settle([{
    kind: "thread", threadId, projectId: testProjectIds.project, projectRoot: "/repo",
    title: "interactions", createdAt: 1, updatedAt: 3, activityAt: 3,
  }]);
  const reader = new WorkbenchTranscriptReader({
    readSnapshot: async request => repository.read(request),
    readContext: async id => repository.readContext(id),
    readMaterializedTurns: async (id, ids) => repository.readMaterializedTurnIds(id, ids),
    readContextUsage: async id => repository.readContextUsage(id),
    readMetadata: async () => ({ entry: null, harness: "opencode" }),
  });
  try {
    const empty = await reader.readPage({ threadId, cursor: null });
    assert.deepEqual(empty.thread.turns, []);
    assert.equal(empty.nextCursor, null);
    assert.deepEqual((await reader.history(threadId)).questionnaireEntries, []);
    const opaque = {
      id: "opaque", type: "functionCallOutput" as const, name: "extension", namespace: null,
      output: [{ type: "input_audio" as const, audio_url: "retained-audio" }],
    };
    const response = { answers: { choice: { answers: ["yes"] } } };
    repository.settle([{
      kind: "turn", threadId, turnId, turnIndex: 0, harnessId: "codex",
      nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native"),
      nativeTurnId: NativeTurnIdSchema.parse("native-turn"), state: "completed",
      createdAt: 1, startedAt: 1, endedAt: 3, durationMs: 2,
    }, {
      kind: "item", threadId, turnId, observedAt: 2, lifecycle: "completed", item: opaque,
    }, {
      kind: "item", threadId, turnId, observedAt: 2, lifecycle: "completed",
      item: {
        id: "browse-command", type: "commandExecution", command: "wb browse run", cwd: "/repo",
        pluginId: null, scriptPath: null, processId: null, source: "agent", status: "completed",
        commandActions: [], aggregatedOutput: "", exitCode: 0, durationMs: 1,
      },
    }, {
      kind: "questionnaire", observedAt: 3,
      entry: {
        threadId, turnId, itemId: "question", requestKey: "question",
        request: { id: "question", title: "", summary: "", submitLabel: "", questions: [
          { id: "choice", header: "", question: "continue?", options: [], allowOther: false, isSecret: false },
        ] },
        response, resolvedAt: 3, insertAfterItemId: "browse-command", insertAfterItemIndex: 1,
      },
    }, {
      kind: "steer", observedAt: 3,
      entry: { threadId, turnId, entryKey: "steer", input: [{ type: "text", text: "retry", text_elements: [] }],
        status: "interrupted", attemptedAt: 2, resolvedAt: 3, requestId: null, canonicalItemId: null, error: null },
    }, {
      kind: "browse",
      entry: { action: "snapshot", actionIndex: 0, assetUrl: null, commandItemId: "browse-command",
        detailKind: "text", detailLabel: "snapshot", detailText: "retained result", durationMs: 1,
        entryKey: "browse", recordedAt: 3, session: "session", state: "completed", threadId, turnId },
    }]);
    const page = await reader.readPage({ threadId, cursor: null });
    const generic = page.thread.turns[0]!.items.find(item => item.type === "generic");
    assert.ok(generic?.type === "generic");
    assert.equal(generic.nativeType, opaque.type);
    assert.deepEqual(generic.safeValue, opaque);
    assert.deepEqual(page.questionnaireEntries[0]?.response, response);
    const command = page.thread.turns[0]!.items.find(item => item.type === "commandExecution")!;
    assert.equal(page.questionnaireEntries[0]?.insertAfterItemId, command.id);
    assert.equal(page.steerEntries[0]?.status, "interrupted");
    assert.equal(page.browseResultEntries[0]?.detailText, "retained result");
    assert.equal(page.browseResultEntries[0]?.commandItemId, command.id);
    const history = await reader.history(threadId);
    assert.deepEqual(history.questionnaireEntries, page.questionnaireEntries);
    assert.deepEqual(history.steerEntries, page.steerEntries);
    assert.deepEqual(history.browseResultEntries, page.browseResultEntries);
  } finally { database.close(); }
});

test("canonical pages retain delivered steer state and stored context usage", async (t) => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const threadId = WorkbenchThreadIdSchema.parse("steer-thread");
  const turnId = WorkbenchTurnIdSchema.parse("steer-turn");
  const itemId = WorkbenchItemIdSchema.parse("steer-item");
  repository.settle([{
    kind: "thread", threadId, projectId: testProjectIds.project, projectRoot: "/repo",
    title: "steer", createdAt: 1, updatedAt: 3, activityAt: 3,
  }, {
    kind: "turn", threadId, turnId, turnIndex: 0, harnessId: "opencode",
    nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native"),
    nativeTurnId: NativeTurnIdSchema.parse("native-turn"), state: "inProgress",
    createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  }, {
    kind: "steer", observedAt: 3,
    entry: {
      threadId, turnId, itemId, entryKey: itemId,
      input: [{ type: "text", text: "change course", text_elements: [] }],
      status: "sent", attemptedAt: 2, resolvedAt: 3, requestId: null,
      canonicalItemId: itemId, clientUserMessageId: "client-steer", error: null,
    },
  }, {
    kind: "threadContextUsage", threadId, initialise: false,
    snapshot: { tokenUsage: {
      last: { cacheWriteInputTokens: 0, cachedInputTokens: 10, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 125 },
      total: { cacheWriteInputTokens: 0, cachedInputTokens: 10, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 125 },
      modelContextWindow: 200_000,
    } },
  }]);
  let usageFailure = false;
  const warnings: object[][] = [];
  t.mock.method(console, "warn", (...args: object[]) => { warnings.push(args); });
  const reader = new WorkbenchTranscriptReader({
    readSnapshot: async request => repository.read(request),
    readContext: async id => repository.readContext(id),
    readMaterializedTurns: async (id, ids) => repository.readMaterializedTurnIds(id, ids),
    readContextUsage: async id => {
      if (usageFailure) throw new Error("private storage details");
      return repository.readContextUsage(id);
    },
    readMetadata: async () => ({ entry: null, harness: "opencode" }),
  });
  try {
    const page = await reader.readPage({ threadId, cursor: null });
    const item = page.thread.turns[0]!.items[0]!;
    assert.deepEqual(getWorkbenchInputState(item), { kind: "steer", status: "sent" });
    assert.equal(page.steerEntries[0]?.canonicalItemId, item.id);
    assert.equal(page.steerEntries[0]?.clientUserMessageId, "client-steer");
    assert.equal(page.thread.tokenUsage?.modelContextWindow, 200_000);
    usageFailure = true;
    const withoutUsage = await reader.readPage({ threadId, cursor: null });
    assert.deepEqual(withoutUsage.thread.turns, page.thread.turns);
    assert.equal(withoutUsage.thread.tokenUsage, null);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings.flat().join(" ").includes("private storage details"));
  } finally { database.close(); }
});
