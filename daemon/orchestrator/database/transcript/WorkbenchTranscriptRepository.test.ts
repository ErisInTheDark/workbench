/*
 * No production exports. Tests protect stable transcript identity, live materialization, source replacement, enrichment survival, bounded hydration, and atomic settlement. Keywords: transcript, repository, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import { withWorkbenchThreadItemIdentity } from "workbench-shared/workbench/thread/thread-item-identity";
import { projectWorkbenchTranscriptItems } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import { resolveSteerHistoryItemId } from "workbench-shared/workbench/thread/thread-steer-history";
import type { WorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "./workbench-transcript-types.ts";

function createRepository(options: { onStatement?: (sql: string) => void } = {}) {
  const database = options.onStatement
    ? new Database(":memory:", { verbose: options.onStatement })
    : new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return {
    database,
    repository: new WorkbenchTranscriptRepository(database),
  };
}

function threadObservation(threadId = "thread"): Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" }> {
  return {
    kind: "thread",
    threadId,
    projectId: "project",
    projectRoot: "C:/project",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    activityAt: 1,
  };
}

function turnObservation(
  turnId: string,
  turnIndex: number,
  threadId = "thread",
): Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }> {
  return {
    kind: "turn",
    threadId,
    turnId,
    turnIndex,
    harnessId: "codex",
    nativeLocation: "C:/project",
    nativeThreadId: "native-thread",
    nativeTurnId: turnId,
    state: "completed",
    createdAt: turnIndex + 2,
    startedAt: turnIndex + 2,
    endedAt: turnIndex + 3,
    durationMs: 1_000,
  };
}

function canonicalWindowSelectCount(itemCount: number) {
  const statements: string[] = [];
  const { database, repository } = createRepository({
    onStatement: (sql) => statements.push(sql),
  });
  try {
    const window = canonicalWindow([
      threadObservation(),
      turnObservation("turn", 0),
      ...Array.from({ length: itemCount }, (_, index): WorkbenchTranscriptAtomicObservation => ({
        kind: "item",
        threadId: "thread",
        turnId: "turn",
        lifecycle: "completed",
        observedAt: index + 3,
        item: {
          id: `message-${index}`,
          memoryCitation: null,
          delivery: null,
          questions: null,
          phase: "commentary",
          text: `message ${index}`,
          type: "agentMessage",
        },
      })),
    ], ["turn"]);
    repository.settle([window]);
    statements.length = 0;
    repository.settle([window]);
    return statements.filter((sql) => /^\s*select\b/iu.test(sql)).length;
  } finally {
    database.close();
  }
}

function canonicalWindow(
  observations: WorkbenchTranscriptAtomicObservation[],
  materializedTurnIds: string[],
  threadId = "thread",
): WorkbenchTranscriptObservation {
  return {
    kind: "canonicalWindow",
    contentVersion: 3,
    materializedTurnIds,
    observations,
    threadId,
  };
}

function providerTurnScope(
  observations: WorkbenchTranscriptAtomicObservation[],
  completeTurnIds: string[],
  threadId = "thread",
): WorkbenchTranscriptObservation {
  return {
    completeTurnIds,
    kind: "providerTurnScope",
    observations: observations.map((observation) => observation.kind === "item"
      ? { ...observation, item: withWorkbenchThreadItemIdentity(observation.item, getCodexItemIdentityKind(observation.item)) }
      : observation),
    threadId,
  };
}

test("canonical reads convert only selected retained bodies and preserve old references across reopen", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("older", 0),
      turnObservation("newer", 1),
      ...["older", "newer"].map((turnId): WorkbenchTranscriptAtomicObservation => ({
        kind: "item", threadId: "thread", turnId, lifecycle: "completed", observedAt: 4,
        item: { type: "reasoning", id: `${turnId}-reasoning`, summary: ["preserve"], content: [] },
        timeline: { itemId: `${turnId}-reasoning`, aliases: [`${turnId}-alias`],
          firstSeenAt: 3, lastSeenAt: 4, startedAt: 3, completedAt: 4 },
      })),
      {
        kind: "questionnaire", observedAt: 5, entry: {
          threadId: "thread", turnId: "newer", itemId: "questionnaire", requestKey: "question",
          insertAfterItemId: null, insertAfterItemIndex: null,
          request: { id: "question", title: "", summary: "", submitLabel: "", questions: [{
            id: "choice", header: "", question: "Choose", allowOther: false, isSecret: false, options: [],
          }] },
          response: { answers: { choice: { answers: ["retained answer"] } } }, resolvedAt: 5,
        },
      },
    ], ["older", "newer"])]);
    const before = repository.read({ threadId: "thread", turnLimit: 2 })!;
    const identities = new WorkbenchThreadIdentityRepository(database);
    const thread = identities.resolve({ threadId: "native-thread" })!;
    const snapshot = repository.read({ threadId: thread.threadId, turnIds: ["newer"], turnLimit: 1 })!;
    assert.ok(snapshot);
    assert.equal(snapshot.loadedTurnIds.length, 1);
    assert.notEqual(snapshot.loadedTurnIds[0], "newer");
    assert.ok(snapshot.turns.every(({ identity_origin }) => identity_origin === "workbench"));
    assert.ok(snapshot.rows.threadItems.every(({ public_id }) => public_id !== null));
    assert.deepEqual(snapshot.rows.threadItems.map(({ id, item_position }) => [id, item_position]),
      before.rows.threadItems.filter(({ turn_id }) => turn_id === "newer").map(({ id, item_position }) => [id, item_position]));
    assert.deepEqual(snapshot.rows.threadInteractionAnswers, before.rows.threadInteractionAnswers);
    const untouched = database.prepare("SELECT public_id FROM thread_items WHERE source_id = 'older-reasoning'").get() as { public_id: string | null };
    assert.equal(untouched.public_id, null);
    const items = new WorkbenchTranscriptIdentityRepository(database);
    const reasoningId = snapshot.rows.threadItems.find(({ source_id }) => source_id === "newer-reasoning")!.public_id;
    assert.equal(items.resolve({ threadId: thread.threadId, itemId: "newer-alias" })?.itemId, reasoningId);
    const questionnaireId = snapshot.rows.threadItems.find(({ type }) => type === "questionnaire")!.public_id;
    assert.equal(items.resolve({ threadId: thread.threadId, itemId: "workbench:questionnaire-history:questionnaire" })?.itemId, questionnaireId);
    const reopened = new WorkbenchTranscriptRepository(database);
    assert.deepEqual(reopened.read({ threadId: "thread", turnIds: ["newer"], turnLimit: 1 }), snapshot);
    assert.deepEqual(reopened.read({ threadId: thread.threadId, turnIds: snapshot.loadedTurnIds, turnLimit: 1 }), snapshot);
    assert.deepEqual(reopened.readMaterializedTurnIds("thread", ["newer", "absent"]), ["newer"]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("failed retained item conversion rolls back turn identities and earlier item links", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([canonicalWindow([
      threadObservation(), turnObservation("turn", 0),
      ...["first", "second"].map((id): WorkbenchTranscriptAtomicObservation => ({
        kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 4,
        item: { id, type: "reasoning", summary: [id], content: [] },
        timeline: { itemId: id, aliases: ["conflicting-alias"], firstSeenAt: 3, lastSeenAt: 4, startedAt: 3, completedAt: 4 },
      })),
    ], ["turn"])]);
    const thread = new WorkbenchThreadIdentityRepository(database).resolve({ threadId: "native-thread" })!;
    assert.throws(() => repository.read({ threadId: thread.threadId, turnLimit: 1 }),
      /UNIQUE constraint|conflicting aliases/iu);
    assert.deepEqual(database.prepare("SELECT id, identity_origin FROM thread_turns").all(),
      [{ id: "turn", identity_origin: "legacy" }]);
    assert.deepEqual(database.prepare("SELECT public_id FROM thread_items").all(), [{ public_id: null }, { public_id: null }]);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_transcript_item_identities").all(), []);
    assert.deepEqual(database.prepare("SELECT alias FROM workbench_turn_legacy_aliases").all(), []);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("metadata-only catalogs transfer native identity without claiming a turn body is materialized", () => {
  const { database, repository } = createRepository();
  try {
    const identity = new WorkbenchThreadIdentityRepository(database);
    const native = { harness: "codex", nativeLocation: "C:/project", nativeThreadId: "native-thread" };
    const thread = identity.observe({
      native, projectId: "project", projectRoot: "C:/project", title: "Thread",
      createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const catalog = {
      kind: "turnCatalog", threadId: thread.threadId,
      catalog: [threadObservation(thread.threadId), turnObservation("known-turn", 0, thread.threadId)],
    } as const;
    repository.settle([catalog]);
    assert.equal(identity.resolveNative(native)?.threadId, thread.threadId);
    assert.equal(identity.resolveNative(native)?.bindings[0]?.pending, false);
    assert.deepEqual(repository.readMaterializedTurnIds(thread.threadId, ["known-turn"]), []);
    assert.equal(repository.read({ threadId: thread.threadId, turnLimit: 1 }), null);
    repository.settle([{
      kind: "canonicalWindow", threadId: thread.threadId, contentVersion: 3,
      materializedTurnIds: ["known-turn"],
      observations: [
        ...catalog.catalog,
        {
          kind: "item", threadId: thread.threadId, turnId: "known-turn", lifecycle: "completed", observedAt: 3,
          item: {
            id: "message", type: "agentMessage", phase: "commentary", text: "Loaded later",
            memoryCitation: null, delivery: null, questions: null,
          },
        },
      ],
    }]);
    const materialized = repository.read({ threadId: thread.threadId, turnLimit: 1 });
    assert.equal(materialized?.rows.threadItemAssistantMessages[0]?.text, "Loaded later");
    repository.settle([catalog]);
    assert.deepEqual(repository.read({ threadId: thread.threadId, turnLimit: 1 }), materialized);
  } finally {
    database.close();
  }
});

test("body recording reuses admitted identities and keeps provisional source reuse isolated by turn", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([threadObservation(), turnObservation("first", 0), turnObservation("second", 1)]);
    const identities = new WorkbenchTranscriptIdentityRepository(database);
    const observations = ["first", "second"].map((turnId): Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> => {
      const identity = identities.admit({
        threadId: "thread",
        sources: [{ turnId, sourceId: "item-1", kind: "provisional" }],
        legacyAliases: [],
      });
      return {
        kind: "item", threadId: "thread", turnId, publicItemId: identity.itemId,
        lifecycle: "completed", observedAt: 5,
        item: withWorkbenchThreadItemIdentity({
          id: "item-1", type: "agentMessage", text: turnId, phase: "commentary",
          memoryCitation: null, delivery: null, questions: null,
        }, "provisional"),
      };
    });
    repository.settle(observations);
    const before = repository.read({ threadId: "thread", turnLimit: 2 })!;
    assert.deepEqual(before.rows.threadItems.map(({ public_id, turn_id }) => [public_id, turn_id]), observations.map(({ publicItemId, turnId }) => [publicItemId, turnId]));
    assert.deepEqual(before.rows.threadItemAssistantMessages.map(({ text }) => text), ["first", "second"]);
    const projected = projectWorkbenchTranscript(before);
    assert.equal(projected.success, true);
    if (!projected.success) throw new Error("Admitted item projection failed.");
    assert.deepEqual(projected.data.turns.flatMap(({ items }) => items.map(({ id }) => id)), observations.map(({ publicItemId }) => publicItemId));
    assert.deepEqual(projected.data.turns.flatMap(({ items }) => items.map((item) => getWorkbenchThreadItemIdentityKind(item as ThreadItem))), ["provisional", "provisional"]);
    repository.settle(observations);
    assert.deepEqual(repository.read({ threadId: "thread", turnLimit: 2 }), before);
    const reread = providerTurnScope([
      turnObservation("first", 0),
      turnObservation("second", 1),
      ...observations.map((observation) => ({
        ...observation,
        item: { ...observation.item, text: `${observation.turnId} updated` },
      })),
    ], ["first", "second"]);
    repository.settle([reread]);
    repository.settle([reread]);
    const afterReread = repository.read({ threadId: "thread", turnLimit: 2 })!;
    assert.deepEqual(afterReread.rows.threadItems, before.rows.threadItems);
    assert.deepEqual(afterReread.rows.threadItemAssistantMessages.map(({ text }) => text), ["first updated", "second updated"]);

    const failedIdentity = identities.admit({
      threadId: "thread", sources: [{ turnId: "second", sourceId: "bad", kind: "stable" }], legacyAliases: [],
    });
    assert.throws(() => repository.settle([{
      ...observations[1]!, publicItemId: failedIdentity.itemId, itemPosition: -1,
      item: { ...observations[1]!.item, id: "bad" },
    }]));
    assert.equal(identities.resolve({ threadId: "thread", itemId: failedIdentity.itemId })?.itemId, failedIdentity.itemId);
    assert.deepEqual(repository.read({ threadId: "thread", turnLimit: 2 }), afterReread);
  } finally {
    database.close();
  }
});

test("body recording rejects unadmitted identity and mismatched source ownership without leftover bodies", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([threadObservation(), turnObservation("turn", 0)]);
    const identity = new WorkbenchTranscriptIdentityRepository(database).admit({
      threadId: "thread", sources: [{ turnId: "turn", sourceId: "source", kind: "stable" }], legacyAliases: [],
    });
    const observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> = {
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 5,
      item: { id: "source", type: "contextCompaction" },
    };
    assert.throws(() => repository.settle([{
      ...observation, publicItemId: "d3a73029-f4c9-4e60-894a-3dc7e4918405",
    }]), /identity.*admitted/iu);
    assert.throws(() => repository.settle([{
      ...observation, publicItemId: identity.itemId, item: { ...observation.item, id: "unrelated" },
    }]), /source.*identity/iu);
    assert.equal(repository.read({ threadId: "thread", turnLimit: 1 })?.rows.threadItems.length, 0);
  } finally {
    database.close();
  }
});

test("a delayed compatibility window cannot replace a directly materialized live turn", () => {
  const { database, repository } = createRepository();
  try {
    const item = {
      kind: "item", threadId: "thread", turnId: "live", lifecycle: "completed", observedAt: 20,
      item: { id: "answer", type: "agentMessage", text: "live answer", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
    } satisfies WorkbenchTranscriptAtomicObservation;
    repository.settle([threadObservation(), turnObservation("live", 1), item]);
    const before = repository.read({ threadId: "thread", turnIds: ["live"], turnLimit: 1 })!;
    repository.settle([canonicalWindow([
      threadObservation(), turnObservation("old", 0),
      { ...turnObservation("live", 1), state: "inProgress", endedAt: null },
      { ...item, item: { ...item.item, text: "stale answer" } },
    ], ["old", "live"])]);
    const after = repository.read({ threadId: "thread", turnIds: ["live"], turnLimit: 1 })!;
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(after.turns.find(({ id }) => id === "live"), before.turns[0]);
    assert.ok(repository.read({ threadId: "thread", turnIds: ["old"], turnLimit: 1 }));
    repository.settle([canonicalWindow([threadObservation(), turnObservation("live", 1)], ["live"])]);
    assert.deepEqual(repository.read({ threadId: "thread", turnIds: ["live"], turnLimit: 1 })!.rows, before.rows);
    database.prepare("DELETE FROM thread_turn_materializations WHERE turn_id = 'live'").run();
    const beforeRejectedImport = database.prepare("SELECT * FROM thread_items ORDER BY id").all();
    assert.throws(() => repository.settle([canonicalWindow([
      threadObservation(), turnObservation("missing", 2), turnObservation("live", 1), item,
    ], ["missing", "live"])]), /already contains items/);
    assert.deepEqual(database.prepare("SELECT * FROM thread_items ORDER BY id").all(), beforeRejectedImport);
    assert.equal(database.prepare("SELECT id FROM thread_turns WHERE id = 'missing'").get(), undefined);
  } finally {
    database.close();
  }
});

test("first historical bodies complete missing timing without changing retained or live facts", () => {
  const { database, repository } = createRepository();
  try {
    const missing = { ...turnObservation("missing", 0), startedAt: null, endedAt: null, durationMs: null };
    const known = turnObservation("known", 1);
    const unloaded = { ...turnObservation("unloaded", 2), durationMs: null };
    const live = { ...turnObservation("live", 3), durationMs: null };
    repository.settle([{
      kind: "usageWindow", threadId: "thread",
      catalog: [threadObservation(), missing, known, unloaded, live],
      observations: [],
    }]);
    repository.settle([live]);
    const before = database.prepare("SELECT * FROM thread_turns ORDER BY turn_index").all();
    const window = canonicalWindow([
      threadObservation(),
      turnObservation("missing", 0),
      { ...known, startedAt: 100, endedAt: 200, durationMs: 100, state: "inProgress" },
      turnObservation("unloaded", 2),
      turnObservation("live", 3),
    ], ["missing", "known", "live"]);
    repository.settle([window]);
    const snapshot = repository.read({ threadId: "thread", turnIds: ["missing", "known", "live"], turnLimit: 3 })!;
    assert.deepEqual(snapshot.turns.map(({ started_at, ended_at, duration_ms }) => ({
      started_at, ended_at, duration_ms,
    })), [
      { started_at: 2, ended_at: 3, duration_ms: 1_000 },
      { started_at: 3, ended_at: 4, duration_ms: 1_000 },
      { started_at: 4, ended_at: 5, duration_ms: null },
      { started_at: 5, ended_at: 6, duration_ms: null },
    ]);
    assert.deepEqual(snapshot.turns.slice(1), before.slice(1));
    assert.equal(repository.read({ threadId: "thread", turnIds: ["unloaded"], turnLimit: 1 }), null);
    repository.settle([window]);
    assert.deepEqual(repository.read({ threadId: "thread", turnIds: ["missing", "known", "live"], turnLimit: 3 }), snapshot);
  } finally {
    database.close();
  }
});

test("usage-only import seeds catalog parents but never materializes transcript bodies", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([{
      kind: "usageWindow", threadId: "thread",
      catalog: [threadObservation(), turnObservation("turn", 0)],
      observations: [{
        kind: "turnUsageContext", model: "recorded-model", serviceTier: null,
        observedAt: 5, threadId: "thread", turnId: "turn",
      }],
    }]);
    assert.equal(repository.read({ threadId: "thread", turnIds: ["turn"], turnLimit: 1 }), null);
    assert.equal((database.prepare("SELECT model FROM thread_turn_usage WHERE turn_id = 'turn'").get() as { model: string }).model, "recorded-model");
    repository.settle([turnObservation("turn", 0)]);
    const before = repository.read({ threadId: "thread", turnIds: ["turn"], turnLimit: 1 });
    repository.settle([{
      kind: "usageWindow", threadId: "thread",
      catalog: [threadObservation(), { ...turnObservation("turn", 0), state: "inProgress", endedAt: null }],
      observations: [],
    }]);
    assert.deepEqual(repository.read({ threadId: "thread", turnIds: ["turn"], turnLimit: 1 }), before);
    assert.throws(() => repository.settle([{
      kind: "usageWindow", threadId: "thread",
      catalog: [threadObservation(), turnObservation("illegal", 1)],
      observations: [turnObservation("illegal", 1)],
    } as unknown as WorkbenchTranscriptObservation]), /non-usage fact/);
    assert.equal(database.prepare("SELECT id FROM thread_turns WHERE id = 'illegal'").get(), undefined);
  } finally {
    database.close();
  }
});

test("patch observations retain partial evidence and failed feedback through echoes and provider omission", () => {
  const { database, repository } = createRepository();
  try {
    const item: WorkbenchFileChangeItem = {
      id: "patch", type: "fileChange", status: "failed", workbenchPolicy: "automaticEscalation",
      workbenchRecovery: { state: "failed", detail: "injection connection closed" },
      changes: [{
        path: "file.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n",
        workbenchAnalysis: {
          additions: 1, deletions: 1, detail: "another hunk is ambiguous", outcome: "partial",
          hunks: [{
            additions: 1, deletions: 1, index: 0, outcome: "present", reason: null,
            candidates: [4], currentStart: 4, currentEnd: 4, oldStart: 1, newStart: 1,
          }, {
            additions: 0, deletions: 0, index: 1, outcome: "uncertain", reason: "repeated matches",
            candidates: [8, 12], currentStart: null, currentEnd: null, oldStart: 7, newStart: 7,
          }],
        },
      }],
    };
    const observation: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 9, item,
    };
    repository.settle([threadObservation(), turnObservation("turn", 0), observation]);
    const readItem = () => {
      const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
      const projection = projectWorkbenchTranscriptItems(snapshot.rows);
      assert.ok(projection.success);
      assert.equal(projection.data.length, 1);
      return projection.data[0]!.item;
    };
    assert.deepEqual(readItem(), item);
    const native: WorkbenchFileChangeItem = {
      id: item.id, type: "fileChange", status: "failed",
      changes: item.changes.map(({ workbenchAnalysis: _, ...change }) => change),
    };
    repository.settle([{ ...observation, item: native }]);
    assert.deepEqual(readItem(), item);
    repository.settle([providerTurnScope([turnObservation("turn", 0), { ...observation, item: native }], ["turn"])]);
    repository.settle([providerTurnScope([turnObservation("turn", 0)], ["turn"])]);
    assert.deepEqual(readItem(), item);
  } finally {
    database.close();
  }
});

test("native output content and queue acceptance survive echoes and omitted provider history", () => {
  const { database, repository } = createRepository();
  try {
    const item: WorkbenchToolOutput = {
      id: "fco_screenshot", type: "functionCallOutput", name: "screenshot", namespace: "workbench",
      output: [{ type: "input_text", text: "captured" }, { type: "input_image", image_url: "/image.png", detail: "original" }],
      workbenchInjectionAcceptedAt: 9,
    };
    const observation: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 9, item,
    };
    repository.settle([threadObservation(), turnObservation("turn", 0), observation]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
    const projected = projectWorkbenchTranscriptItems(snapshot.rows);
    assert.ok(projected.success);
    assert.deepEqual(projected.data[0]?.item, item);
    const originalRoot = snapshot.rows.threadItems[0]!;
    const { workbenchInjectionAcceptedAt: _, ...native } = item;
    repository.settle([providerTurnScope([turnObservation("turn", 0), { ...observation, item: native }], ["turn"])]);
    repository.settle([providerTurnScope([turnObservation("turn", 0)], ["turn"])]);
    const after = repository.read({ threadId: "thread", turnLimit: 1 })!;
    assert.deepEqual(after.rows.threadItems.map(({ id, source_id, item_position }) => ({ id, source_id, item_position })), [
      { id: originalRoot.id, source_id: item.id, item_position: originalRoot.item_position },
    ]);
    const afterProjection = projectWorkbenchTranscriptItems(after.rows);
    assert.ok(afterProjection.success);
    assert.deepEqual(afterProjection.data[0]?.item, item);
  } finally {
    database.close();
  }
});

test("selected legacy opaque outputs become supported without losing identity or unsupported neighbours", () => {
  const { database, repository } = createRepository();
  try {
    const unsupported: ThreadItem = {
      id: "legacy", type: "functionCallOutput", name: "context", namespace: null,
      output: [{ type: "input_audio", audio_url: "audio" }],
    };
    const observation: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 9, item: unsupported,
    };
    repository.settle([threadObservation(), turnObservation("turn", 0), observation, { ...observation, item: { ...unsupported, id: "unsupported" } }]);
    const original = repository.read({ threadId: "thread", turnLimit: 1 })!;
    const supported = { ...unsupported, output: "old retained context" };
    database.prepare("UPDATE thread_item_unknown SET safe_json = ? WHERE item_id = ?").run(
      JSON.stringify(supported), original.rows.threadItems.find(({ source_id }) => source_id === "legacy")!.id,
    );
    const after = repository.read({ threadId: "thread", turnLimit: 1 })!;
    assert.deepEqual(after.rows.threadItems.map(({ id, source_id, item_position }) => ({ id, source_id, item_position })),
      original.rows.threadItems.map(({ id, source_id, item_position }) => ({ id, source_id, item_position })));
    const projected = projectWorkbenchTranscriptItems(after.rows);
    assert.ok(projected.success);
    assert.deepEqual(projected.data[0]?.item, supported);
    assert.equal(projected.data[1]?.item.type, "generic");
  } finally {
    database.close();
  }
});

test("standalone provider turns establish a readable live materialization", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([
      threadObservation(),
      turnObservation("live", 0),
    ]);
    assert.deepEqual(
      repository.read({ threadId: "thread", turnIds: ["live"], turnLimit: 1 })?.loadedTurnIds,
      ["live"],
    );

    repository.settle([{
      kind: "item",
      threadId: "thread",
      turnId: "live",
      lifecycle: "completed",
      observedAt: 4,
      item: {
        id: "message",
        memoryCitation: null,
        phase: "commentary",
        text: "recorded directly",
        delivery: null,
        questions: null,
        type: "agentMessage",
      },
    }]);
    assert.deepEqual(
      repository.read({ threadId: "thread", turnIds: ["live"], turnLimit: 1 })?.rows.threadItems
        .map(({ source_id }) => source_id),
      ["message"],
    );
  } finally {
    database.close();
  }
});

test("canonical window relational reads stay bounded as item count grows", () => {
  const oneItemSelects = canonicalWindowSelectCount(1);
  const manyItemSelects = canonicalWindowSelectCount(40);
  assert.ok(
    manyItemSelects <= oneItemSelects + 2,
    `Canonical settlement SELECTs grew with item count: one=${oneItemSelects}, many=${manyItemSelects}`,
  );
});

test("source ids stay thread-scoped while repeated same-thread items keep their earliest turn owner", () => {
  const { database, repository } = createRepository();
  const item = (threadId: string, turnId: string, text: string): WorkbenchTranscriptAtomicObservation => ({
    kind: "item",
    threadId,
    turnId,
    lifecycle: "completed",
    observedAt: 4,
    item: {
      id: "carried",
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "commentary",
      text,
      type: "agentMessage",
    },
  });
  try {
    repository.settle([
      threadObservation(),
      turnObservation("earlier", 0),
      turnObservation("later", 1),
    ]);
    repository.settle([item("thread", "later", "arrived latest-first")]);
    repository.settle([item("thread", "earlier", "repaired to first owner")]);
    repository.settle([item("thread", "later", "repeated later")]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 2 });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.rows.threadItems.map(({ source_id, item_position, turn_id }) => [source_id, turn_id, item_position]),
      [["carried", "earlier", 0]],
    );

    repository.settle([
      threadObservation("other"),
      turnObservation("other-turn", 0, "other"),
    ]);
    repository.settle([item("other", "other-turn", "different thread")]);
    const otherSnapshot = repository.read({ threadId: "other", turnLimit: 1 });
    assert.ok(otherSnapshot);
    assert.deepEqual(
      otherSnapshot.rows.threadItems.map(({ source_id, turn_id }) => [source_id, turn_id]),
      [["carried", "other-turn"]],
    );
    assert.notEqual(snapshot.rows.threadItems[0]?.id, otherSnapshot.rows.threadItems[0]?.id);
  } finally {
    database.close();
  }
});

test("atomic lifecycle facts merge without erasing richer item or turn timing", () => {
  const { database, repository } = createRepository();
  const message = (sourceId: string, observedAt: number, timeline?: Extract<
    WorkbenchTranscriptAtomicObservation,
    { kind: "item" }
  >["timeline"]): WorkbenchTranscriptAtomicObservation => ({
    item: {
      id: sourceId,
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "commentary",
      text: sourceId,
      type: "agentMessage",
    },
    kind: "item",
    lifecycle: timeline?.completedAt ? "completed" : "streaming",
    observedAt,
    ...(timeline ? { timeline } : {}),
    threadId: "thread",
    turnId: "turn",
  });
  try {
    repository.settle([
      threadObservation(),
      {
        ...turnObservation("turn", 0),
        durationMs: null,
        endedAt: null,
        startedAt: 10,
        state: "inProgress",
      },
    ]);
    repository.settle([message("first", 10, {
      aliases: ["shared-alias"],
      completedAt: null,
      firstSeenAt: 10,
      itemId: "first",
      lastSeenAt: 10,
      startedAt: 10,
    })]);
    repository.settle([message("first", 15)]);
    repository.settle([message("first", 20, {
      completedAt: 20,
      firstSeenAt: 20,
      itemId: "first",
      lastSeenAt: 20,
      startedAt: null,
    })]);
    repository.settle([message("second", 12, {
      aliases: ["shared-alias"],
      completedAt: 12,
      firstSeenAt: 12,
      itemId: "second",
      lastSeenAt: 12,
      startedAt: null,
    })]);
    repository.settle([{
      ...turnObservation("turn", 0),
      durationMs: 10,
      endedAt: 20,
      startedAt: 10,
      state: "completed",
    }]);
    repository.settle([{
      ...turnObservation("turn", 0),
      durationMs: null,
      endedAt: null,
      startedAt: null,
      state: "inProgress",
    }]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.turns.map(({ duration_ms, ended_at, started_at, state }) => ({
        duration_ms,
        ended_at,
        started_at,
        state,
      })),
      [{ duration_ms: 10, ended_at: 20, started_at: 10, state: "completed" }],
    );
    const sourceIdsByItemId = new Map(snapshot.rows.threadItems.map(({ id, source_id }) => [id, source_id]));
    assert.deepEqual(
      snapshot.rows.threadItemTimelines
        .map(({ item_id, ...timeline }) => ({ sourceId: sourceIdsByItemId.get(item_id), ...timeline }))
        .sort((left, right) => left.sourceId!.localeCompare(right.sourceId!)),
      [{
        completed_at: 20,
        first_seen_at: 10,
        last_seen_at: 20,
        sourceId: "first",
        started_at: 10,
      }, {
        completed_at: 12,
        first_seen_at: 12,
        last_seen_at: 12,
        sourceId: "second",
        started_at: null,
      }],
    );
    assert.deepEqual(
      snapshot.rows.threadItemTimelineAliases.map(({ alias, item_id }) => ({
        alias,
        sourceId: sourceIdsByItemId.get(item_id),
      })),
      [
        { alias: "shared-alias", sourceId: "first" },
        { alias: "shared-alias", sourceId: "second" },
      ],
    );
  } finally {
    database.close();
  }
});

test("top-level mutations reject a metadata-only compatibility turn", () => {
  const { database, repository } = createRepository();
  const steer: WorkbenchSteerHistoryEntry = {
    attemptedAt: 3,
    canonicalItemId: null,
    clientUserMessageId: "client",
    entryKey: "steer",
    error: "delivery failed",
    input: [{ text: "hello", text_elements: [], type: "text" }],
    requestId: "1",
    resolvedAt: 4,
    status: "failed",
    threadId: "thread",
    turnId: "metadata",
  };
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("metadata", 0),
    ], [])]);
    assert.equal(
      repository.read({ threadId: "thread", turnIds: ["metadata"], turnLimit: 1 }),
      null,
    );

    const observations: WorkbenchTranscriptAtomicObservation[] = [{
      kind: "item",
      threadId: "thread",
      turnId: "metadata",
      lifecycle: "completed",
      observedAt: 4,
      item: {
        id: "message",
        memoryCitation: null,
        phase: "commentary",
        text: "not initialized",
        delivery: null,
        questions: null,
        type: "agentMessage",
      },
    }, {
      kind: "questionnaire",
      entry: {
        insertAfterItemId: null,
        insertAfterItemIndex: null,
        itemId: "questionnaire",
        request: {
          id: "request",
          questions: [{
            allowOther: false,
            header: "Choice",
            id: "choice",
            isSecret: false,
            options: [],
            question: "Pick one",
          }],
          submitLabel: "Submit",
          summary: "Choose",
          title: "Questionnaire",
        },
        requestKey: "request",
        resolvedAt: 4,
        response: { answers: { choice: { answers: ["one"] } } },
        threadId: "thread",
        turnId: "metadata",
      },
      observedAt: 4,
    }, {
      kind: "steer",
      entry: steer,
      observedAt: 4,
    }, {
      kind: "browse",
      entry: {
        action: "snapshot",
        actionIndex: 0,
        assetUrl: null,
        commandItemId: null,
        detailKind: "text",
        detailLabel: "snapshot",
        detailText: "not initialized",
        durationMs: 1,
        entryKey: "browse",
        recordedAt: 4,
        session: "session",
        state: "completed",
        threadId: "thread",
        turnId: "metadata",
      },
    }];
    for (const observation of observations) {
      assert.throws(
        () => repository.settle([observation]),
        /unmaterialized turn/u,
      );
    }
  } finally {
    database.close();
  }
});

test("source replacement keeps canonical identity and Browse enrichment while replacing stale children", () => {
  const { database, repository } = createRepository();
  const browseAsset = {
    byteLength: 12,
    digest: "a".repeat(64),
    mimeType: "image/png",
    storageKey: `/api/transcript-assets/codex/dGhyZWFk/${"a".repeat(64)}.png`,
  };
  const browseObservation = {
    kind: "browse",
    asset: browseAsset,
    entry: {
      action: "snapshot",
      actionIndex: 0,
      assetUrl: browseAsset.storageKey,
      commandItemId: "command",
      durationMs: 10,
      entryKey: "browse-entry",
      recordedAt: 5,
      session: "research",
      state: "completed",
      threadId: "thread",
      turnId: "turn-0",
      detailKind: "text",
      detailLabel: "snapshot",
      detailText: "done",
    },
  } satisfies WorkbenchTranscriptObservation;
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("turn-0", 0),
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn-0",
        lifecycle: "completed",
        observedAt: 3,
        item: {
          type: "reasoning",
          id: "reasoning",
          summary: ["visible summary"],
          content: ["hidden raw reasoning"],
        },
      },
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn-0",
        lifecycle: "streaming",
        observedAt: 4,
        item: {
          type: "commandExecution",
          id: "command",
          pluginId: null,
          scriptPath: null,
          command: "rg old",
          cwd: "C:/project",
          processId: "process",
          source: "agent",
          status: "inProgress",
          commandActions: [{ type: "search", command: "rg old", query: "old", path: null }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
      browseObservation,
    ], ["turn-0"])]);

    repository.settle([{
      kind: "item",
      threadId: "thread",
      turnId: "turn-0",
      lifecycle: "completed",
      observedAt: 6,
      item: {
        type: "commandExecution",
        id: "command",
        pluginId: null,
        scriptPath: null,
        command: "rg new",
        cwd: "C:/project",
        processId: "process",
        source: "agent",
        status: "completed",
        commandActions: [{ type: "search", command: "rg new", query: "new", path: "src" }],
        aggregatedOutput: "match",
        exitCode: 0,
        durationMs: 20,
      },
    }]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 10 });
    assert.ok(snapshot);
    const commandItemId = snapshot.rows.threadItems.find(({ source_id }) => source_id === "command")?.id;
    assert.ok(commandItemId);
    assert.deepEqual(snapshot.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]), [
      ["reasoning", 0],
      ["command", 1],
    ]);
    assert.deepEqual(snapshot.rows.threadReasoningSections.map(({ text }) => text), ["visible summary"]);
    assert.deepEqual(snapshot.rows.threadOperationProcessSources.map((source) => ({
      command: source.command,
      output: source.output_text,
      revision: source.source_revision,
      state: source.state,
    })), [{
      command: "rg new",
      output: "match",
      revision: 1,
      state: "completed",
    }]);
    assert.deepEqual(snapshot.rows.threadProcessCommandActions.map(({ command, query }) => ({ command, query })), [{
      command: "rg new",
      query: "new",
    }]);
    assert.deepEqual(snapshot.rows.threadBrowseEntries.map(({ asset_digest, entry_key, item_id }) => ({
      asset_digest,
      entry_key,
      item_id,
    })), [{
      asset_digest: browseAsset.digest,
      entry_key: "browse-entry",
      item_id: commandItemId,
    }]);
    assert.deepEqual(snapshot.rows.transcriptAssets, [{
      byte_length: browseAsset.byteLength,
      created_at: 5,
      digest: browseAsset.digest,
      mime_type: browseAsset.mimeType,
      storage_key: browseAsset.storageKey,
    }]);
    assert.throws(() => repository.settle([{
      ...browseObservation,
      asset: { ...browseAsset, byteLength: browseAsset.byteLength + 1 },
    }]), /changed content-addressed metadata/u);
    const identity = new WorkbenchThreadIdentityRepository(database).resolve({ threadId: "thread" });
    assert.ok(identity);
    const converted = repository.read({ threadId: identity.threadId, turnLimit: 10 });
    assert.ok(converted);
    const canonicalAssetUrl = `/api/transcript-assets/codex/${identity.threadId}/${browseAsset.digest}.png`;
    repository.settle([{
      ...browseObservation,
      asset: { ...browseAsset, storageKey: canonicalAssetUrl },
      entry: { ...browseObservation.entry, threadId: identity.threadId, turnId: converted.turns[0]!.id, assetUrl: canonicalAssetUrl },
    }]);
    const repeated = repository.read({ threadId: identity.threadId, turnLimit: 10 });
    assert.ok(repeated);
    assert.deepEqual(repeated.rows.transcriptAssets, converted.rows.transcriptAssets);
    const projection = projectWorkbenchTranscript(repeated);
    assert.equal(projection.success, true);
    if (projection.success) assert.deepEqual(projection.data.browseResultEntries.map((entry) => entry.assetUrl), [canonicalAssetUrl]);
  } finally {
    database.close();
  }
});

for (const windowed of [false, true]) {
  test(`Browse enrichment resolves public and legacy item references within the owning turn (window ${windowed})`, () => {
    const { database, repository } = createRepository();
    try {
      const turns = [turnObservation("first", 0), turnObservation("second", 1)];
      repository.settle([{ kind: "turnCatalog", threadId: "thread", catalog: [threadObservation(), ...turns] }]);
      const identity = new WorkbenchTranscriptIdentityRepository(database).admit({
        threadId: "thread",
        sources: [{ turnId: "first", sourceId: "command", kind: "stable" }],
        legacyAliases: [{ turnId: "first", alias: "old-command-reference" }],
      });
      const command = {
        kind: "item", threadId: "thread", turnId: "first", publicItemId: identity.itemId,
        lifecycle: "completed", observedAt: 3,
        item: {
          type: "commandExecution", id: "command", command: "inspect", cwd: "C:/project",
          pluginId: null, scriptPath: null, processId: null, source: "agent", status: "completed",
          commandActions: [], aggregatedOutput: "done", exitCode: 0, durationMs: 1,
        },
      } satisfies WorkbenchTranscriptAtomicObservation;
      const browse = (commandItemId: string, actionIndex: number, turnId = "first"): WorkbenchTranscriptAtomicObservation => ({
          kind: "browse", entry: {
            action: "snapshot", actionIndex, assetUrl: null, commandItemId, durationMs: 1,
            entryKey: `${turnId}-${commandItemId}`, recordedAt: 4, session: "research",
            state: "completed", threadId: "thread", turnId, detailText: "result",
          },
      });
      const observations = [
        ...[identity.itemId, "old-command-reference", "command"].map((reference, index) => browse(reference, index)),
        browse(identity.itemId, 3, "second"),
      ];
      repository.settle([canonicalWindow([
        threadObservation(), ...turns, command, ...(windowed ? observations : []),
      ], ["first", "second"])]);
      if (!windowed) repository.settle(observations);
      const snapshot = repository.read({ threadId: "thread", turnLimit: 2 })!;
      const root = snapshot.rows.threadItems[0]!;
      const rows = snapshot.rows.threadBrowseEntries;
      assert.equal(rows.length, 3);
      assert.ok(rows.every((entry) => entry.item_id === root.id));
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM transcript_native_records WHERE turn_id = 'second'")
        .get() as { count: number }).count, 1);
    } finally {
      database.close();
    }
  });
}

test("failed and interrupted steers keep the renderer's synthetic item identity", () => {
  const { database, repository } = createRepository();
  const entries: WorkbenchSteerHistoryEntry[] = [
    {
      attemptedAt: 3,
      canonicalItemId: null,
      clientUserMessageId: "failed-client",
      entryKey: "failed-entry",
      error: "delivery failed",
      input: [{ text: "failed steer", text_elements: [], type: "text" }],
      requestId: "1",
      resolvedAt: 4,
      status: "failed",
      threadId: "thread",
      turnId: "turn-0",
    },
    {
      attemptedAt: 5,
      canonicalItemId: null,
      clientUserMessageId: "interrupted-client",
      entryKey: "interrupted-entry",
      error: null,
      input: [{ text: "interrupted steer", text_elements: [], type: "text" }],
      requestId: "2",
      resolvedAt: 6,
      status: "interrupted",
      threadId: "thread",
      turnId: "turn-0",
    },
  ];
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("turn-0", 0),
      ...entries.map((entry): WorkbenchTranscriptAtomicObservation => ({
        kind: "steer",
        entry,
        observedAt: entry.resolvedAt!,
      })),
    ], ["turn-0"])]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.rows.threadItems.map(({ source_id }) => source_id),
      entries.map(resolveSteerHistoryItemId),
    );
    assert.deepEqual(snapshot.rows.threadItemUserMessages.map((row) => ({
      deliveryState: row.delivery_state,
      error: row.error_text,
    })), [
      { deliveryState: "failed", error: "delivery failed" },
      { deliveryState: "interrupted", error: null },
    ]);
  } finally {
    database.close();
  }
});

test("interaction bodies reuse admitted identities and positions through steer settlement changes", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([threadObservation(), turnObservation("turn", 0)]);
    const identities = new WorkbenchTranscriptIdentityRepository(database);
    const steer: WorkbenchSteerHistoryEntry = {
      attemptedAt: 3, canonicalItemId: null, clientUserMessageId: "client", entryKey: "request",
      error: "delivery failed", input: [{ type: "text", text: "keep this", text_elements: [] }],
      requestId: "1", resolvedAt: 4, status: "failed", threadId: "thread", turnId: "turn",
    };
    const interrupted = { ...steer, status: "interrupted" as const, error: null, resolvedAt: 5 };
    const steerIdentity = identities.admit({
      threadId: "thread", sources: [], legacyAliases: [steer, interrupted].map((entry) => ({
        turnId: "turn", alias: resolveSteerHistoryItemId(entry),
      })),
    });
    const questionnaireIdentity = identities.admit({
      threadId: "thread", sources: [],
      legacyAliases: [{ turnId: "turn", alias: "native-questionnaire" }],
    });
    const questionnaire = {
      kind: "questionnaire" as const, observedAt: 4, publicItemId: questionnaireIdentity.itemId,
      entry: {
        threadId: "thread", turnId: "turn", itemId: "native-questionnaire", requestKey: "request",
        insertAfterItemId: null, insertAfterItemIndex: null, resolvedAt: 4,
        request: { id: "1", title: "", summary: "", submitLabel: "", questions: [] },
        response: { answers: {} },
      },
    };
    repository.settle([{ kind: "steer", entry: steer, observedAt: 4, publicItemId: steerIdentity.itemId }, questionnaire]);
    const roots = database.prepare("SELECT id, public_id, item_position FROM thread_items ORDER BY item_position").all();
    assert.deepEqual(roots.map((row) => (row as { public_id: string }).public_id),
      [steerIdentity.itemId, questionnaireIdentity.itemId]);
    repository.settle([{ kind: "steer", entry: interrupted, observedAt: 5, publicItemId: steerIdentity.itemId }, questionnaire]);
    assert.deepEqual(database.prepare("SELECT id, public_id, item_position FROM thread_items ORDER BY item_position").all(), roots);
    const projected = projectWorkbenchTranscriptItems(repository.read({ threadId: "thread", turnLimit: 1 })!.rows);
    assert.equal(projected.success, true);
    if (!projected.success) throw new Error("Interaction projection failed");
    const item = projected.data.find(({ item }) => item.id === steerIdentity.itemId)!.item;
    assert.equal(item.type, "userMessage");
    if (item.type !== "userMessage") throw new Error("Steer projection has the wrong kind");
    assert.deepEqual(getWorkbenchInputState(item), { kind: "steer", status: "interrupted" });
  } finally {
    database.close();
  }
});

test("turn usage settlement keeps context while replacing cumulative token updates", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([
      threadObservation(),
      turnObservation("turn", 0),
      {
        kind: "turnUsageContext",
        model: "gpt-5.4",
        observedAt: 3,
        serviceTier: "fast",
        threadId: "thread",
        turnId: "turn",
      },
      {
        cumulative: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 30,
          reasoningOutputTokens: 10,
          totalTokens: 130,
        },
        kind: "turnTokenUsage",
        observedAt: 4,
        threadId: "thread",
        turnId: "turn",
        usageDataVersion: 2,
      },
      {
        cumulative: {
          cacheWriteInputTokens: 5,
          cachedInputTokens: 40,
          inputTokens: 200,
          outputTokens: 60,
          reasoningOutputTokens: 20,
          totalTokens: 260,
        },
        kind: "turnTokenUsage",
        observedAt: 5,
        threadId: "thread",
        turnId: "turn",
        usageDataVersion: 2,
      },
    ]);
    assert.deepEqual(database.prepare(`
      SELECT model, service_tier, cumulative_input_tokens, cumulative_cached_input_tokens,
        cumulative_cache_write_input_tokens, cumulative_output_tokens,
        cumulative_reasoning_output_tokens, cumulative_total_tokens, usage_data_version
      FROM thread_turn_usage WHERE turn_id = ?
    `).get("turn"), {
      cumulative_cache_write_input_tokens: 5,
      cumulative_cached_input_tokens: 40,
      cumulative_input_tokens: 200,
      cumulative_output_tokens: 60,
      cumulative_reasoning_output_tokens: 20,
      cumulative_total_tokens: 260,
      model: "gpt-5.4",
      service_tier: "fast",
      usage_data_version: 2,
    });
  } finally {
    database.close();
  }
});

test("provider scopes preserve directly recorded items omitted by later snapshots", () => {
  const { database, repository } = createRepository();
  const observedTurn = turnObservation("turn", 0);
  const message = (
    id: string,
    text: string,
    observedAt: number,
  ): WorkbenchTranscriptAtomicObservation => ({
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt,
    item: { id, memoryCitation: null, delivery: null, questions: null, phase: "commentary", text, type: "agentMessage" },
  });
  const command = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 4,
    item: {
      aggregatedOutput: "done",
      command: "echo done",
      commandActions: [],
      cwd: "C:/project",
      durationMs: 1,
      exitCode: 0,
      id: "command",
      pluginId: null,
      processId: null,
      scriptPath: null,
      source: "agent",
      status: "completed",
      type: "commandExecution",
    },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const before = message("item-1", "before", 3);
  const canonicalBefore = message("before", "before", 6);
  const after = message("after", "after", 5);
  try {
    repository.settle([threadObservation(), observedTurn, before, command, after]);
    repository.settle([providerTurnScope([observedTurn, canonicalBefore, after], ["turn"])]);

    assert.deepEqual(
      repository.read({ threadId: "thread", turnLimit: 1 })?.rows.threadItems
        .map(({ source_id, item_position }) => [source_id, item_position]),
      [["before", 0], ["command", 1], ["after", 2]],
    );
  } finally {
    database.close();
  }
});

test("provider settlement converts retained bodies before reconciliation without requiring a browser read", () => {
  const { database, repository } = createRepository();
  try {
    const message = (id: string) => withWorkbenchThreadItemIdentity({
      id, type: "agentMessage" as const, text: "retained commentary", phase: "commentary" as const,
      memoryCitation: null, delivery: null, questions: null,
    }, id === "item-1" ? "provisional" : "stable");
    repository.settle([threadObservation(), turnObservation("older", 0), turnObservation("turn", 1), {
      kind: "item", threadId: "thread", turnId: "older", lifecycle: "completed", observedAt: 3,
      item: { id: "older-reasoning", type: "reasoning", summary: ["older"], content: [] },
    }, {
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 4,
      item: message("item-1"),
    }]);
    const identities = new WorkbenchThreadIdentityRepository(database);
    const thread = identities.resolve({ threadId: "native-thread" })!;
    const turn = identities.resolveTurn({ threadId: thread.threadId, turnId: "turn" })!;
    const items = new WorkbenchTranscriptIdentityRepository(database);
    items.admit({
      threadId: thread.threadId,
      sources: [{ turnId: turn.turnId, kind: "provisional", sourceId: "item-1" }],
      legacyAliases: [],
    });
    const target = items.admit({
      threadId: thread.threadId,
      sources: [{ turnId: turn.turnId, kind: "stable", sourceId: "canonical-message" }],
      legacyAliases: [],
    });
    const original = database.prepare("SELECT id, item_position FROM thread_items WHERE source_id = 'item-1'").get();
    const incoming: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: thread.threadId, turnId: turn.turnId, publicItemId: target.itemId,
      lifecycle: "completed", observedAt: 5, item: message("canonical-message"),
    };
    const scope = providerTurnScope([
      { ...turnObservation("turn", 1, thread.threadId), turnId: turn.turnId },
      incoming,
    ], [turn.turnId], thread.threadId);
    assert.throws(() => repository.settle([scope, { ...incoming, threadId: "wrong-owner" }]));
    assert.equal((database.prepare("SELECT public_id FROM thread_items WHERE source_id = 'item-1'").get() as { public_id: string | null }).public_id, null,
      "Failed settlement must roll back retained identity conversion");
    repository.settle([scope]);
    repository.settle([scope]);
    const snapshot = new WorkbenchTranscriptRepository(database).read({
      threadId: thread.threadId, turnIds: [turn.turnId], turnLimit: 1,
    })!;
    assert.equal(snapshot.rows.threadItems.length, 1);
    assert.deepEqual(snapshot.rows.threadItems.map(({ id, item_position }) => ({ id, item_position })), [original]);
    assert.equal(snapshot.rows.threadItems[0]!.public_id, target.itemId);
    assert.equal(snapshot.rows.threadItemAssistantMessages[0]!.text, message("canonical-message").text);
    for (const itemId of ["item-1", "canonical-message", target.itemId]) {
      assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({
        threadId: thread.threadId, turnId: turn.turnId, itemId,
      })?.itemId, target.itemId);
    }
    assert.equal((database.prepare("SELECT public_id FROM thread_items WHERE source_id = 'older-reasoning'").get() as { public_id: string | null }).public_id, null,
      "Other turns must remain untouched");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

for (const repeatedSource of [false, true]) {
  test(`provider repetition preserves one admitted body and its neighbours (same source ${repeatedSource})`, (context) => {
    const { database, repository } = createRepository();
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      const turn = turnObservation("turn", 0);
      repository.settle([threadObservation(), turn]);
      const identities = new WorkbenchTranscriptIdentityRepository(database);
      const observation = (id: string, text: string): Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> => ({
        kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 3,
        publicItemId: identities.admit({
          threadId: "thread", sources: [{ turnId: "turn", sourceId: id, kind: getCodexItemIdentityKind({ id }) }],
          legacyAliases: [],
        }).itemId,
        item: withWorkbenchThreadItemIdentity({ id, type: "plan", text }, getCodexItemIdentityKind({ id })),
      });
      const before = observation("before", "before");
      const stored = observation("canonical", "first step");
      const after = observation("after", "after");
      repository.settle([before, stored, after]);
      const originalRows = repository.read({ threadId: "thread", turnLimit: 1 })!.rows.threadItems;
      const alias = repeatedSource ? stored : observation("item-1", "first step");
      const updated = observation("canonical", "first step, then second step");
      const scope = providerTurnScope([turn, before, alias, updated, after], ["turn"]);
      for (let pass = 0; pass < 2; pass++) {
        repository.settle([scope]);
        const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
        assert.deepEqual(snapshot.rows.threadItems.map(({ id, public_id, item_position }) => ({ id, public_id, item_position })),
          originalRows.map(({ id, public_id, item_position }) => ({ id, public_id, item_position })));
        const projection = projectWorkbenchTranscript(snapshot);
        assert.ok("data" in projection);
        assert.deepEqual(projection.data.turns[0]!.items.map((item) => item.type === "plan" ? item.text : null),
          ["before", "first step, then second step", "after"]);
        assert.equal(identities.resolve({ threadId: "thread", itemId: alias.item.id })?.itemId, stored.publicItemId);
        assert.deepEqual(database.pragma("foreign_key_check"), []);
      }
      assert.equal(warnings.mock.callCount(), repeatedSource ? 2 : 0,
        "Expected same-fact overlap is not malformed provider input.");
    } finally { database.close(); }
  });
}

for (const residual of [false, true]) {
  for (const aggregateHasBody of [false, true]) {
    test(`reasoning aggregate preserves admitted canonical sources (residual ${residual}, stored aggregate ${aggregateHasBody})`, (context) => {
      const { database, repository } = createRepository();
      const warnings = context.mock.method(console, "warn", () => undefined);
      try {
        const turn = turnObservation("turn", 0);
        repository.settle([threadObservation(), turn]);
        const identities = new WorkbenchTranscriptIdentityRepository(database);
        const reasoning = (id: string, summary: string[]): Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> => {
          const identity = identities.admit({
            threadId: "thread", sources: [{ turnId: "turn", sourceId: id, kind: getCodexItemIdentityKind({ id }) }],
            legacyAliases: [],
          });
          return {
            kind: "item", threadId: "thread", turnId: "turn", publicItemId: identity.itemId,
            lifecycle: "completed", observedAt: 3,
            item: withWorkbenchThreadItemIdentity({ id, type: "reasoning", summary, content: [] }, getCodexItemIdentityKind({ id })),
          };
        };
        const alpha = reasoning("rs-alpha", ["alpha"]);
        const beta = reasoning("rs-beta", ["beta"]);
        repository.settle([alpha, beta]);
        const before = repository.read({ threadId: "thread", turnLimit: 1 })!.rows.threadItems;
        const aggregate = reasoning("item-1", ["alpha", "beta", ...(residual ? ["new thought"] : [])]);
        if (aggregateHasBody) repository.settle([aggregate]);
        const replacement = providerTurnScope([turn, aggregate], ["turn"]);
        repository.settle([replacement]);
        repository.settle([replacement]);
        const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
        assert.deepEqual(snapshot.rows.threadItems.slice(0, 2).map(({ id, public_id, source_id, item_position }) => (
          { id, public_id, source_id, item_position }
        )), before.map(({ id, public_id, source_id, item_position }) => ({ id, public_id, source_id, item_position })));
        const projection = projectWorkbenchTranscript(snapshot);
        assert.ok("data" in projection);
        const items = projection.data.turns[0]!.items;
        assert.deepEqual(items.map(({ id }) => id), [
          alpha.publicItemId, beta.publicItemId, ...(residual ? [aggregate.publicItemId] : []),
        ]);
        assert.deepEqual(items.flatMap((item) => item.type === "reasoning" ? item.summary.filter(Boolean) : []),
          ["alpha", "beta", ...(residual ? ["new thought"] : [])]);
        assert.equal(identities.resolve({ threadId: "thread", itemId: "item-1" })?.itemId, aggregate.publicItemId,
          "One aggregate cannot become an alias of multiple canonical items.");
        assert.deepEqual(database.pragma("foreign_key_check"), []);
        assert.equal(warnings.mock.callCount(), 0, "Aggregate and direct evidence may represent the same reasoning.");
      } finally { database.close(); }
    });
  }
}

for (const targetHasBody of [false, true]) {
  test(`same-fact reconciliation preserves public aliases and body evidence (target body ${targetHasBody})`, () => {
    const { database, repository } = createRepository();
    try {
      const turn = turnObservation("turn", 0);
      repository.settle([threadObservation(), turn]);
      const identities = new WorkbenchTranscriptIdentityRepository(database);
      const source = identities.admit({
        threadId: "thread", sources: [{ turnId: "turn", sourceId: "item-1", kind: "provisional" }], legacyAliases: [],
      });
      const target = identities.admit({
        threadId: "thread", sources: [{ turnId: "turn", sourceId: "message", kind: "stable" }], legacyAliases: [],
      });
      const observation = (publicItemId: string, id: string): WorkbenchTranscriptAtomicObservation => ({
        kind: "item", threadId: "thread", turnId: "turn", publicItemId,
        lifecycle: "completed", observedAt: 3,
        item: withWorkbenchThreadItemIdentity({
          id, type: "agentMessage", text: "one fact", phase: "commentary",
          memoryCitation: null, delivery: null, questions: null,
        }, id === "item-1" ? "provisional" : "stable"),
      });
      repository.settle([observation(source.itemId, "item-1")]);
      const sourceRoot = repository.read({ threadId: "thread", turnLimit: 1 })!.rows.threadItems[0]!;
      repository.settle([{
        kind: "nativeEvidence", threadId: "thread", turnId: "turn", itemId: source.itemId,
        harnessId: "codex", nativeLocation: "C:/project", nativeThreadId: "native-thread",
        nativeTurnId: "turn", nativeItemId: "item-1", nativeEventId: null, clientId: null,
        nativeSequence: null, recordKind: "event", payloadJson: '{"fact":"retained"}', recordedAt: 3,
      }]);
      if (targetHasBody) repository.settle([observation(target.itemId, "message")]);
      const before = repository.read({ threadId: "thread", turnLimit: 1 })!;
      const expectedRootId = targetHasBody
        ? before.rows.threadItems.find(({ public_id }) => public_id === target.itemId)!.id
        : sourceRoot.id;
      const recovery = providerTurnScope([turn, observation(target.itemId, "message")], ["turn"]);
      repository.settle([recovery]);
      repository.settle([recovery]);
      repository.settle([providerTurnScope([
        turn, observation(source.itemId, "item-1"), observation(target.itemId, "message"),
      ], ["turn"])]);
      const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
      assert.deepEqual(snapshot.rows.threadItems.map(({ id, public_id }) => [id, public_id]), [[expectedRootId, target.itemId]]);
      assert.equal(snapshot.rows.threadItemAssistantMessages[0]?.text, "one fact");
      const reloadedIdentities = new WorkbenchTranscriptIdentityRepository(database);
      for (const itemId of [source.itemId, target.itemId, "item-1", "message"]) {
        assert.equal(reloadedIdentities.resolve({ threadId: "thread", turnId: "turn", itemId })?.itemId, target.itemId);
      }
      assert.deepEqual(database.prepare("SELECT item_id, payload_json FROM transcript_native_records").all(), [
        { item_id: expectedRootId, payload_json: '{"fact":"retained"}' },
      ]);
      const oldReference = observation(source.itemId, "item-1");
      if (oldReference.kind !== "item" || oldReference.item.type !== "agentMessage") throw new Error("Invalid message fixture");
      repository.settle([providerTurnScope([turn, {
        ...oldReference,
        item: { ...oldReference.item, text: "updated through old identity" },
      }], ["turn"])]);
      const updated = repository.read({ threadId: "thread", turnLimit: 1 })!;
      assert.deepEqual(updated.rows.threadItems.map(({ public_id }) => public_id), [target.itemId]);
      assert.equal(updated.rows.threadItemAssistantMessages[0]?.text, "updated through old identity");
      repository.settle([{
        ...oldReference,
        item: { ...oldReference.item, text: "live settlement through old identity" },
      }]);
      const live = repository.read({ threadId: "thread", turnLimit: 1 })!;
      assert.deepEqual(live.rows.threadItems.map(({ id, public_id }) => [id, public_id]), [[expectedRootId, target.itemId]]);
      assert.equal(live.rows.threadItemAssistantMessages[0]?.text, "live settlement through old identity");
    } finally {
      database.close();
    }
  });
}

for (const scenario of [
  { current: ["before", "after"], expected: ["before", "missing", "after"] },
  { current: ["before", "local", "after"], expected: ["before", "local", "after", "missing"] },
]) {
  test(`recovery inserts missing items only into a confirmed canonical gap (${scenario.current.join(", ")})`, () => {
    const { database, repository } = createRepository();
    const observedTurn = turnObservation("turn", 0);
    const message = (id: string): WorkbenchTranscriptAtomicObservation => ({
      kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 3,
      item: {
        id, type: "agentMessage", text: id, phase: "commentary",
        memoryCitation: null, delivery: null, questions: null,
      },
    });
    try {
      repository.settle([threadObservation(), observedTurn, ...scenario.current.map(message)]);
      const recovery = providerTurnScope([
        observedTurn, ...["before", "missing", "after"].map(message),
      ], ["turn"]);
      repository.settle([recovery]);
      repository.settle([recovery]);
      const items = repository.read({ threadId: "thread", turnLimit: 1 })!.rows.threadItems;
      assert.deepEqual(items.map(({ source_id }) => source_id), scenario.expected);
      assert.deepEqual(items.map(({ item_position }) => item_position), scenario.expected.map((_, index) => index));
    } finally {
      database.close();
    }
  });
}

test("complete provider scopes collapse proven aliases while preserving admitted facts and placement", () => {
  const { database, repository } = createRepository();
  const failedSteer: WorkbenchSteerHistoryEntry = {
    attemptedAt: 8,
    canonicalItemId: null,
    clientUserMessageId: "failed-client",
    entryKey: "failed-entry",
    error: "delivery failed",
    input: [{ text: "failed steer", text_elements: [], type: "text" }],
    requestId: "steer-request",
    resolvedAt: 9,
    status: "failed",
    threadId: "thread",
    turnId: "turn",
  };
  const questionnaire = {
    kind: "questionnaire",
    entry: {
      insertAfterItemId: "command",
      insertAfterItemIndex: 4,
      itemId: "questionnaire",
      request: {
        id: "questionnaire-request",
        questions: [{
          allowOther: false,
          header: "Choice",
          id: "choice",
          isSecret: false,
          options: [],
          question: "Pick one",
        }],
        submitLabel: "Submit",
        summary: "Choose",
        title: "Questionnaire",
      },
      requestKey: "questionnaire-request",
      resolvedAt: 7,
      response: { answers: { choice: { answers: ["one"] } } },
      threadId: "thread",
      turnId: "turn",
    },
    observedAt: 7,
  } satisfies WorkbenchTranscriptAtomicObservation;
  const command = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 6,
    item: {
      aggregatedOutput: "done",
      command: "echo done",
      commandActions: [],
      cwd: "C:/project",
      durationMs: 1,
      exitCode: 0,
      id: "command",
      pluginId: null,
      processId: null,
      scriptPath: null,
      source: "agent",
      status: "completed",
      type: "commandExecution",
    },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const browse = {
    kind: "browse",
    asset: {
      byteLength: 12,
      digest: "b".repeat(64),
      mimeType: "image/png",
      storageKey: `/api/transcript-assets/codex/dGhyZWFk/${"b".repeat(64)}.png`,
    },
    entry: {
      action: "snapshot",
      actionIndex: 0,
      assetUrl: `/api/transcript-assets/codex/dGhyZWFk/${"b".repeat(64)}.png`,
      commandItemId: "command",
      durationMs: 1,
      entryKey: "browse",
      recordedAt: 10,
      session: "session",
      state: "completed",
      threadId: "thread",
      turnId: "turn",
    },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const user = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 3,
    timeline: {
      completedAt: 3,
      firstSeenAt: 2,
      itemId: "user",
      lastSeenAt: 3,
      startedAt: 2,
    },
    item: {
      clientId: "initial-client",
      content: [{ text: "start", text_elements: [], type: "text" }],
      id: "user",
      type: "userMessage",
    },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const reasoningA = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 4,
    item: { content: [], id: "rs-a", summary: ["alpha"], type: "reasoning" },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const reasoningB = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 5,
    item: { content: ["beta"], id: "rs-b", summary: [], type: "reasoning" },
  } satisfies WorkbenchTranscriptAtomicObservation;
  const answer = {
    kind: "item",
    threadId: "thread",
    turnId: "turn",
    lifecycle: "completed",
    observedAt: 12,
    item: {
      id: "answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "final_answer",
      text: "done",
      type: "agentMessage",
    },
  } satisfies WorkbenchTranscriptAtomicObservation;
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("turn", 0),
      user,
      {
        ...user,
        observedAt: 4,
        timeline: {
          completedAt: 4,
          firstSeenAt: 4,
          itemId: "item-1",
          lastSeenAt: 4,
          startedAt: 4,
        },
        item: { ...user.item, id: "item-1" },
      },
      reasoningA,
      command,
      reasoningB,
      {
        ...reasoningA,
        observedAt: 6,
        item: {
          content: ["beta"],
          id: "item-2",
          summary: ["alpha"],
          type: "reasoning",
        },
      },
      questionnaire,
      { kind: "steer", entry: failedSteer, observedAt: 9 },
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn",
        lifecycle: "interrupted",
        observedAt: 10,
        item: {
          changes: [],
          id: "workbench-file-failure",
          status: "failed",
          type: "fileChange",
          workbenchFailureKind: "unclaimed",
        },
      },
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn",
        lifecycle: "completed",
        observedAt: 11,
        item: {
          id: "stale",
          memoryCitation: null,
          delivery: null,
          questions: null,
          phase: "commentary",
          text: "stale",
          type: "agentMessage",
        },
      },
      answer,
      browse,
    ], ["turn"])]);

    repository.settle([{
      kind: "nativeEvidence", threadId: "thread", turnId: "turn", itemId: "item-2",
      harnessId: "codex", nativeLocation: "C:/project", nativeThreadId: "native-thread",
      nativeTurnId: "turn", nativeItemId: "item-2", nativeEventId: null, clientId: null,
      nativeSequence: null, recordKind: "snapshot", payloadJson: '{"aggregate":true}', recordedAt: 19,
    }]);
    const replacement = providerTurnScope([
      turnObservation("turn", 0),
      {
        ...user,
        observedAt: 20,
        timeline: undefined,
        item: { ...user.item, id: "item-1" },
      },
      {
        ...reasoningA,
        observedAt: 20,
        item: {
          content: ["beta"],
          id: "item-2",
          summary: ["alpha"],
          type: "reasoning",
        },
      },
      { ...command, observedAt: 20 },
      {
        ...answer,
        observedAt: 20,
        item: { ...answer.item, id: "item-4" },
      },
    ], ["turn"]);
    repository.settle([replacement]);
    repository.settle([replacement]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]),
      [
        ["user", 0],
        ["rs-a", 1],
        ["command", 2],
        ["rs-b", 3],
        ["questionnaire", 4],
        [resolveSteerHistoryItemId(failedSteer), 5],
        ["workbench-file-failure", 6],
        ["stale", 7],
        ["answer", 8],
      ],
    );
    assert.equal(snapshot.rows.threadBrowseEntries.length, 1);
    assert.equal(snapshot.rows.transcriptAssets.length, 1);
    assert.equal(snapshot.rows.threadItemInteractions.length, 1);
    assert.equal(snapshot.rows.threadItemFileChanges[0]?.workbench_failure_kind, "unclaimed");
    assert.deepEqual(database.prepare(`
      SELECT link_kind, turn_id, item_id, native_item_id, payload_json FROM transcript_native_records
    `).all(), [{
      link_kind: "turn", turn_id: "turn", item_id: null, native_item_id: "item-2", payload_json: '{"aggregate":true}',
    }]);
    const sourceIdsByItemId = new Map(snapshot.rows.threadItems.map(({ id, source_id }) => [id, source_id]));
    assert.deepEqual(snapshot.rows.threadItemTimelines.map((timeline) => ({
      completedAt: timeline.completed_at,
      firstSeenAt: timeline.first_seen_at,
      lastSeenAt: timeline.last_seen_at,
      sourceId: sourceIdsByItemId.get(timeline.item_id),
      startedAt: timeline.started_at,
    })).sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId))), [
      {
        completedAt: 20,
        firstSeenAt: 20,
        lastSeenAt: 20,
        sourceId: "answer",
        startedAt: null,
      },
      {
        completedAt: 3,
        firstSeenAt: 2,
        lastSeenAt: 3,
        sourceId: "user",
        startedAt: 2,
      },
    ]);
    assert.deepEqual(snapshot.rows.threadItemTimelineAliases.map(({ alias, item_id }) => ({
      alias,
      sourceId: sourceIdsByItemId.get(item_id),
    })).sort((left, right) => left.alias.localeCompare(right.alias)), [
      { alias: "item-1", sourceId: "user" },
      { alias: "item-4", sourceId: "answer" },
    ]);
  } finally {
    database.close();
  }
});

test("complete provider scopes keep metadata-only turns unmaterialized", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([providerTurnScope([
      threadObservation(),
      turnObservation("metadata", 0),
      turnObservation("loaded", 1),
      {
        kind: "item",
        threadId: "thread",
        turnId: "loaded",
        lifecycle: "completed",
        observedAt: 5,
        item: {
          id: "answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
          phase: "final_answer",
          text: "done",
          type: "agentMessage",
        },
      },
    ], ["loaded"])]);

    assert.equal(repository.read({ threadId: "thread", turnIds: ["metadata"], turnLimit: 1 }), null);
    assert.deepEqual(
      repository.read({ threadId: "thread", turnIds: ["loaded"], turnLimit: 1 })?.rows.threadItems
        .map(({ source_id }) => source_id),
      ["answer"],
    );
  } finally {
    database.close();
  }
});

test("settled questionnaires may reuse one provider request key across turns", () => {
  const { database, repository } = createRepository();
  const questionnaire = (
    turnId: string,
    itemId: string,
    resolvedAt: number,
  ): WorkbenchTranscriptAtomicObservation => ({
    kind: "questionnaire",
    entry: {
      insertAfterItemId: null,
      insertAfterItemIndex: null,
      itemId,
      request: {
        id: `request-${turnId}`,
        questions: [{
          allowOther: false,
          header: "Choice",
          id: "choice",
          isSecret: false,
          options: [],
          question: "Pick one",
        }],
        submitLabel: "Submit",
        summary: "Choose",
        title: "Questionnaire",
      },
      requestKey: "reused",
      resolvedAt,
      response: { answers: { choice: { answers: [turnId] } } },
      threadId: "thread",
      turnId,
    },
    observedAt: resolvedAt,
  });
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      turnObservation("older", 0),
      turnObservation("newer", 1),
      questionnaire("older", "question-older", 3),
      questionnaire("newer", "question-newer", 5),
    ], ["older", "newer"])]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 2 });
    assert.ok(snapshot);
    const sourceIdsByItemId = new Map(snapshot.rows.threadItems.map(({ id, source_id }) => [id, source_id]));
    assert.deepEqual(
      snapshot.rows.threadItemInteractions
        .map(({ item_id, request_key }) => [sourceIdsByItemId.get(item_id), request_key])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      [
        ["question-newer", "reused"],
        ["question-older", "reused"],
      ],
    );
    assert.deepEqual(
      snapshot.rows.threadItems
        .map(({ source_id, turn_id }) => [source_id, turn_id])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ["question-newer", "newer"],
        ["question-older", "older"],
      ],
    );
  } finally {
    database.close();
  }
});

test("hydration pages keep full turn metadata and load only the requested immutable item window", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      ...[0, 1, 2].flatMap((turnIndex): WorkbenchTranscriptAtomicObservation[] => [
        turnObservation(`turn-${turnIndex}`, turnIndex),
        {
          kind: "item",
          threadId: "thread",
          turnId: `turn-${turnIndex}`,
          lifecycle: "completed",
          observedAt: turnIndex + 10,
          item: {
            type: "agentMessage",
            id: `message-${turnIndex}`,
            text: `message ${turnIndex}`,
            phase: turnIndex === 2 ? "final_answer" : "commentary",
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        },
      ]),
    ], ["turn-0", "turn-1", "turn-2"])]);

    const latest = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(latest);
    assert.deepEqual(latest.turns.map(({ id }) => id), ["turn-0", "turn-1", "turn-2"]);
    assert.deepEqual(latest.loadedTurnIds, ["turn-2"]);
    assert.deepEqual(latest.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]), [["message-2", 0]]);
    assert.equal(latest.hasPreviousTurns, true);

    const previous = repository.read({ threadId: "thread", beforeTurnIndex: 2, turnLimit: 1 });
    assert.ok(previous);
    assert.deepEqual(previous.loadedTurnIds, ["turn-1"]);
    assert.deepEqual(previous.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]), [["message-1", 0]]);
    assert.equal(previous.hasPreviousTurns, true);

    const exact = repository.read({ threadId: "thread", turnIds: ["turn-0", "turn-2"], turnLimit: 1 });
    assert.ok(exact);
    assert.deepEqual(exact.loadedTurnIds, ["turn-0", "turn-2"]);
    assert.deepEqual(exact.rows.threadItems.map(({ source_id }) => source_id), ["message-0", "message-2"]);
    assert.equal(exact.hasPreviousTurns, false);
  } finally {
    database.close();
  }
});

test("JIT windows seed independent turns without importing old interactions into existing bodies", () => {
  const { database, repository } = createRepository();
  const turnHistory = Array.from({ length: 9 }, (_, turnIndex) => (
    turnObservation(`turn-${turnIndex}`, turnIndex)
  ));
  const message = (id: string, text: string): WorkbenchTranscriptAtomicObservation => ({
    kind: "item",
    threadId: "thread",
    turnId: "turn-8",
    lifecycle: "completed",
    observedAt: 20,
    item: { id, memoryCitation: null, delivery: null, questions: null, phase: "commentary", text, type: "agentMessage" },
  });
  try {
    repository.settle([canonicalWindow([
      threadObservation(),
      ...turnHistory,
      message("opening", "opening"),
      message("answer", "answer"),
    ], ["turn-8"])]);

    const first = repository.read({ threadId: "thread", turnIds: ["turn-8"], turnLimit: 1 });
    assert.ok(first);
    assert.deepEqual(
      first.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]),
      [["opening", 0], ["answer", 1]],
    );
    assert.equal(repository.read({ threadId: "thread", turnIds: ["turn-0"], turnLimit: 1 }), null);
    assert.equal(repository.read({ threadId: "thread", turnIds: ["not-imported"], turnLimit: 1 }), null);
    repository.settle([canonicalWindow([
      threadObservation("other"),
      turnObservation("other-turn", 0, "other"),
    ], ["other-turn"], "other")]);
    assert.throws(
      () => repository.read({ threadId: "thread", turnIds: ["other-turn"], turnLimit: 1 }),
      /belongs to thread other/,
    );

    repository.settle([canonicalWindow([
      threadObservation(),
      ...turnHistory,
      message("opening", "opening"),
      {
        kind: "questionnaire",
        entry: {
          insertAfterItemId: "opening",
          insertAfterItemIndex: 0,
          itemId: null,
          request: {
            id: "request",
            questions: [{
              allowOther: false,
              header: "Choice",
              id: "choice",
              isSecret: false,
              options: [{ description: "Pick it", label: "One" }],
              question: "Pick one",
            }],
            submitLabel: "Submit",
            summary: "Choose",
            title: "Questionnaire",
          },
          requestKey: "questionnaire",
          resolvedAt: 21,
          response: { answers: {} },
          threadId: "thread",
          turnId: "turn-8",
        },
        observedAt: 21,
      },
      message("answer", "answer"),
    ], ["turn-8"])]);

    const inserted = repository.read({ threadId: "thread", turnIds: ["turn-8"], turnLimit: 1 });
    assert.ok(inserted);
    assert.deepEqual(inserted.rows, first.rows);

    repository.settle([canonicalWindow([
      threadObservation(),
      ...turnHistory,
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn-0",
        lifecycle: "completed",
        observedAt: 22,
        item: { id: "ancestor", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "ancestor", type: "agentMessage" },
      },
    ], ["turn-0"])]);
    const afterAncestor = repository.read({ threadId: "thread", turnIds: ["turn-8"], turnLimit: 1 });
    assert.ok(afterAncestor);
    assert.deepEqual(
      afterAncestor.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]),
      inserted.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]),
    );
  } finally {
    database.close();
  }
});

test("an old content stamp never deletes stored turns when importing an independent historical body", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([
      canonicalWindow([
        threadObservation(),
        turnObservation("partial", 2),
        {
          kind: "item",
          threadId: "thread",
          turnId: "partial",
          lifecycle: "completed",
          observedAt: 3,
          item: { id: "partial-item", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "partial", type: "agentMessage" },
        },
      ], ["partial"]),
      canonicalWindow([
        threadObservation("other"),
        turnObservation("other-turn", 0, "other"),
      ], ["other-turn"], "other"),
    ]);
    database.prepare("UPDATE workbench_threads SET transcript_content_version = 1").run();

    repository.settle([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: ["older", "newer"],
      threadId: "thread",
      observations: [
        threadObservation(),
        turnObservation("older", 0),
        turnObservation("newer", 1),
        {
          kind: "item",
          threadId: "thread",
          turnId: "older",
          lifecycle: "completed",
          observedAt: 20,
          timeline: {
            aliases: ["message-alias"],
            completedAt: 20,
            firstSeenAt: 10,
            itemId: "message",
            lastSeenAt: 20,
            startedAt: 11,
          },
          item: { id: "message", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "complete", type: "agentMessage" },
        },
      ],
    }]);
    const snapshot = repository.read({ threadId: "thread", turnIds: ["older"], turnLimit: 1 });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.turns.map(({ id, turn_index }) => [id, turn_index]), [["older", 0], ["newer", 1], ["partial", 2]]);
    assert.equal(repository.read({ threadId: "thread", turnIds: ["partial"], turnLimit: 1 })?.rows.threadItemAssistantMessages[0]?.text, "partial");
    assert.deepEqual(snapshot.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]), [["message", 0]]);
    const messageItemId = snapshot.rows.threadItems[0]?.id;
    assert.ok(messageItemId);
    assert.deepEqual(snapshot.rows.threadItemTimelines, [{
      item_id: messageItemId,
      first_seen_at: 10,
      last_seen_at: 20,
      started_at: 11,
      completed_at: 20,
    }]);
    assert.deepEqual(snapshot.rows.threadItemTimelineAliases, [{ alias: "message-alias", item_id: messageItemId }]);
    assert.ok(repository.read({ threadId: "other", turnLimit: 1 }));

    assert.throws(() => repository.settle([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: ["missing"],
      threadId: "other",
      observations: [
        threadObservation("other"),
        {
          kind: "item",
          threadId: "other",
          turnId: "missing",
          lifecycle: "completed",
          observedAt: 30,
          item: { id: "invalid", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "invalid", type: "agentMessage" },
        },
      ],
    }]), /materializes unknown turn/);
    const other = repository.read({ threadId: "other", turnLimit: 1 });
    assert.ok(other);
    assert.equal(other.thread.transcript_content_version, 1);
    assert.deepEqual(other.turns.map(({ id }) => id), ["other-turn"]);
  } finally {
    database.close();
  }
});

test("collaboration tools preserve native status and relationships through SQLite", () => {
  const { database, repository } = createRepository();
  try {
    const tools = ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "sendMessage", "followupTask", "interruptAgent", "listAgents"] as const;
    const statuses = ["inProgress", "completed", "failed", "interrupted"] as const;
    const items: ThreadItem[] = tools.flatMap((tool) => statuses.map((status) => ({
      type: "collabAgentToolCall",
      id: `${tool}-${status}`,
      tool,
      status,
      senderThreadId: "thread",
      receiverThreadIds: ["child"],
      prompt: "follow up",
      model: null,
      reasoningEffort: null,
      agentsStates: { child: { status: "running", message: null } },
    })));
    repository.settle([
      threadObservation(),
      turnObservation("turn", 0),
      ...items.map((item): WorkbenchTranscriptAtomicObservation => ({
        kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 3, item,
      })),
    ]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 10 });
    assert.ok(snapshot);
    const projection = projectWorkbenchTranscriptItems(snapshot.rows);
    assert.ok(projection.success);
    assert.deepEqual(projection.data.map(({ item }) => item), items);
  } finally {
    database.close();
  }
});

test("unsupported function output retains all parts in opaque storage", () => {
  const { database, repository } = createRepository();
  try {
    const item: ThreadItem = {
      type: "functionCallOutput", id: "output", name: "lookup", namespace: "tools",
      output: [{ type: "input_text", text: "lookup result" }, { type: "input_audio", audio_url: "audio" }],
    };
    repository.settle([
      threadObservation(),
      turnObservation("turn", 0),
      { kind: "item", threadId: "thread", turnId: "turn", lifecycle: "completed", observedAt: 3, item },
    ]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 10 });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.rows.threadItemUnknown.map(({ safe_json }) => JSON.parse(safe_json)), [item]);
  } finally {
    database.close();
  }
});

test("unsupported items remain opaque and a later invalid observation rolls back the complete settlement", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([canonicalWindow(
      [threadObservation(), turnObservation("turn-0", 0)],
      ["turn-0"],
    )]);
    assert.throws(() => repository.settle([
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn-0",
        lifecycle: "completed",
        observedAt: 3,
        item: { type: "imageView", id: "opaque", path: "C:/project/image.png" },
      },
      {
        kind: "item",
        threadId: "thread",
        turnId: "missing",
        lifecycle: "completed",
        observedAt: 4,
        item: {
          type: "agentMessage",
          id: "invalid",
          text: "no owner",
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      },
    ]), /unknown turn owner/);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 10 });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.rows.threadItems, []);

    repository.settle([{
      kind: "item",
      threadId: "thread",
      turnId: "turn-0",
      lifecycle: "completed",
      observedAt: 5,
      item: { type: "imageView", id: "opaque", path: "C:/project/image.png" },
    }]);
    const settled = repository.read({ threadId: "thread", turnLimit: 10 });
    assert.ok(settled);
    assert.deepEqual(settled.rows.threadItemUnknown.map(({ native_type, safe_json }) => ({
      native_type,
      value: JSON.parse(safe_json),
    })), [{
      native_type: "imageView",
      value: { type: "imageView", id: "opaque", path: "C:/project/image.png" },
    }]);
  } finally {
    database.close();
  }
});

test("capture-gap settlement records one closed thread-owned failure interval", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([
      threadObservation(),
      turnObservation("turn", 0),
      {
        closedAt: 20,
        errorText: "settlement failed",
        gapId: "gap",
        kind: "captureGap",
        openedAt: 10,
        reason: "sqlite transcript settlement failed",
        state: "reconciled",
        threadId: "thread",
        turnId: "turn",
      },
    ]);
    assert.deepEqual(
      database.prepare("SELECT * FROM transcript_capture_gaps WHERE id = ?").get("gap"),
      {
        closed_at: 20,
        error_text: "settlement failed",
        id: "gap",
        opened_at: 10,
        reason: "sqlite transcript settlement failed",
        state: "reconciled",
        thread_id: "thread",
        turn_id: "turn",
      },
    );
  } finally {
    database.close();
  }
});
