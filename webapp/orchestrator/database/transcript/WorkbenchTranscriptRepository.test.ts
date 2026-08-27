/*
 * No production exports. Tests protect stable transcript identity, source replacement, enrichment survival, bounded hydration, and atomic settlement. Keywords: transcript, repository, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import type { WorkbenchSteerHistoryEntry } from "../../../lib/types.ts";
import { createSyntheticSteerHistoryItemId } from "../../../lib/workbench/thread/thread-steer-history.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "./workbench-transcript-types.ts";

function createRepository() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return {
    database,
    repository: new WorkbenchTranscriptRepository(database),
  };
}

function threadObservation(threadId = "thread"): WorkbenchTranscriptAtomicObservation {
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
): WorkbenchTranscriptAtomicObservation {
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

function canonicalWindow(
  observations: WorkbenchTranscriptAtomicObservation[],
  materializedTurnIds: string[],
  threadId = "thread",
): WorkbenchTranscriptObservation {
  return {
    kind: "canonicalWindow",
    contentVersion: 2,
    materializedTurnIds,
    observations,
    threadId,
  };
}

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
    assert.deepEqual(snapshot.rows.threadItems.map(({ id, item_position }) => [id, item_position]), [
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
      item_id: "command",
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
  } finally {
    database.close();
  }
});

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
      snapshot.rows.threadItems.map(({ id }) => id),
      entries.map(createSyntheticSteerHistoryItemId),
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
    assert.deepEqual(
      snapshot.rows.threadItemInteractions
        .map(({ item_id, request_key }) => [item_id, request_key])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ["question-newer", "reused"],
        ["question-older", "reused"],
      ],
    );
    assert.deepEqual(
      snapshot.rows.threadItems
        .map(({ id, turn_id }) => [id, turn_id])
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
          },
        },
      ]),
    ], ["turn-0", "turn-1", "turn-2"])]);

    const latest = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(latest);
    assert.deepEqual(latest.turns.map(({ id }) => id), ["turn-0", "turn-1", "turn-2"]);
    assert.deepEqual(latest.loadedTurnIds, ["turn-2"]);
    assert.deepEqual(latest.rows.threadItems.map(({ id, item_position }) => [id, item_position]), [["message-2", 0]]);
    assert.equal(latest.hasPreviousTurns, true);

    const previous = repository.read({ threadId: "thread", beforeTurnIndex: 2, turnLimit: 1 });
    assert.ok(previous);
    assert.deepEqual(previous.loadedTurnIds, ["turn-1"]);
    assert.deepEqual(previous.rows.threadItems.map(({ id, item_position }) => [id, item_position]), [["message-1", 0]]);
    assert.equal(previous.hasPreviousTurns, true);

    const exact = repository.read({ threadId: "thread", turnIds: ["turn-0", "turn-2"], turnLimit: 1 });
    assert.ok(exact);
    assert.deepEqual(exact.loadedTurnIds, ["turn-0", "turn-2"]);
    assert.deepEqual(exact.rows.threadItems.map(({ id }) => id), ["message-0", "message-2"]);
    assert.equal(exact.hasPreviousTurns, false);
  } finally {
    database.close();
  }
});

test("JIT windows materialize independent turns and replace one turn's local positions atomically", () => {
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
    item: { id, memoryCitation: null, phase: "commentary", text, type: "agentMessage" },
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
      first.rows.threadItems.map(({ id, item_position }) => [id, item_position]),
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
    const insertedPositions = new Map(inserted.rows.threadItems.map(({ id, item_position }) => [id, item_position]));
    const insertedItemId = [...insertedPositions.keys()].find((id) => id !== "opening" && id !== "answer");
    assert.ok(insertedItemId);
    assert.deepEqual(
      inserted.rows.threadItems.map(({ id, item_position }) => [id, item_position]),
      [["opening", 0], [insertedItemId, 1], ["answer", 2]],
    );

    repository.settle([canonicalWindow([
      threadObservation(),
      ...turnHistory,
      {
        kind: "item",
        threadId: "thread",
        turnId: "turn-0",
        lifecycle: "completed",
        observedAt: 22,
        item: { id: "ancestor", memoryCitation: null, phase: "commentary", text: "ancestor", type: "agentMessage" },
      },
    ], ["turn-0"])]);
    const afterAncestor = repository.read({ threadId: "thread", turnIds: ["turn-8"], turnLimit: 1 });
    assert.ok(afterAncestor);
    assert.deepEqual(
      afterAncestor.rows.threadItems.map(({ id, item_position }) => [id, item_position]),
      inserted.rows.threadItems.map(({ id, item_position }) => [id, item_position]),
    );
  } finally {
    database.close();
  }
});

test("complete version-one shadow import replaces only that thread atomically and preserves exact timelines", () => {
  const { database, repository } = createRepository();
  try {
    repository.settle([
      canonicalWindow([
        threadObservation(),
        turnObservation("partial", 0),
        {
          kind: "item",
          threadId: "thread",
          turnId: "partial",
          lifecycle: "completed",
          observedAt: 3,
          item: { id: "partial-item", memoryCitation: null, phase: "commentary", text: "partial", type: "agentMessage" },
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
      contentVersion: 2,
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
          item: { id: "message", memoryCitation: null, phase: "commentary", text: "complete", type: "agentMessage" },
        },
      ],
    }]);
    const snapshot = repository.read({ threadId: "thread", turnIds: ["older"], turnLimit: 1 });
    assert.ok(snapshot);
    assert.equal(snapshot.thread.transcript_content_version, 2);
    assert.deepEqual(snapshot.turns.map(({ id, turn_index }) => [id, turn_index]), [["older", 0], ["newer", 1]]);
    assert.deepEqual(snapshot.rows.threadItems.map(({ id, item_position }) => [id, item_position]), [["message", 0]]);
    assert.deepEqual(snapshot.rows.threadItemTimelines, [{
      item_id: "message",
      first_seen_at: 10,
      last_seen_at: 20,
      started_at: 11,
      completed_at: 20,
    }]);
    assert.deepEqual(snapshot.rows.threadItemTimelineAliases, [{ alias: "message-alias", item_id: "message" }]);
    assert.ok(repository.read({ threadId: "other", turnLimit: 1 }));

    assert.throws(() => repository.settle([{
      kind: "canonicalWindow",
      contentVersion: 2,
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
          item: { id: "invalid", memoryCitation: null, phase: "commentary", text: "invalid", type: "agentMessage" },
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
