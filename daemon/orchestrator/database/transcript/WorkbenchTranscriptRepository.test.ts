/*
 * No production exports. Tests protect stable transcript identity, live materialization, source replacement, enrichment survival, bounded hydration, and atomic settlement. Keywords: transcript, repository, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { projectWorkbenchTranscriptItems } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import { createSyntheticSteerHistoryItemId } from "workbench-shared/workbench/thread/thread-steer-history";
import type { WorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
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
    observations,
    threadId,
  };
}

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
    assert.equal(projected.data[1]?.item.type, "unknown");
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
      snapshot.rows.threadItems.map(({ source_id }) => source_id),
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
      command,
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
        ["rs-b", 2],
        ["command", 3],
        ["questionnaire", 4],
        [createSyntheticSteerHistoryItemId(failedSteer), 5],
        ["workbench-file-failure", 6],
        ["stale", 7],
        ["answer", 8],
      ],
    );
    assert.equal(snapshot.rows.threadBrowseEntries.length, 1);
    assert.equal(snapshot.rows.transcriptAssets.length, 1);
    assert.equal(snapshot.rows.threadItemInteractions.length, 1);
    assert.equal(snapshot.rows.threadItemFileChanges[0]?.workbench_failure_kind, "unclaimed");
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
    const insertedPositions = new Map(inserted.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]));
    const insertedItemId = [...insertedPositions.keys()].find((id) => id !== "opening" && id !== "answer");
    assert.ok(insertedItemId);
    assert.deepEqual(
      inserted.rows.threadItems.map(({ source_id, item_position }) => [source_id, item_position]),
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
    assert.equal(snapshot.thread.transcript_content_version, 3);
    assert.deepEqual(snapshot.turns.map(({ id, turn_index }) => [id, turn_index]), [["older", 0], ["newer", 1]]);
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
