/*
 * No production exports. Real SQLite fixtures protect relational item reconstruction, browser projection, hydration, renderer facts, opaque values, and malformed augmentation refusal.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import Database from "better-sqlite3";

import { projectWorkbenchTranscriptItems } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "../../../daemon/server/database/transcript/workbench-transcript-types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const require = createRequire(import.meta.url);
const { installWorkbenchDatabaseSchema } = require("../../../daemon/server/database/workbench-database-schema") as typeof import("../../../daemon/server/database/workbench-database-schema");
const { default: WorkbenchTranscriptRepository } = require("../../../daemon/server/database/transcript/WorkbenchTranscriptRepository") as typeof import("../../../daemon/server/database/transcript/WorkbenchTranscriptRepository");

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///project"),
  },
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "turn-1": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-1"),
  },
};

function createRepository() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return {
    database,
    repository: new WorkbenchTranscriptRepository(database),
  };
}

function thread(): WorkbenchTranscriptAtomicObservation {
  return {
    activityAt: 7_000,
    createdAt: 1_000,
    kind: "thread",
    projectId: fixtureIdentityValues.ProjectId["project"],
    projectRoot: "C:/project",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
    title: "Projected thread",
    updatedAt: 7_000,
  };
}

function turn(turnId: string, turnIndex: number): WorkbenchTranscriptAtomicObservation {
  return {
    createdAt: (turnIndex + 1) * 1_000,
    durationMs: 1_000,
    endedAt: (turnIndex + 2) * 1_000,
    harnessId: "codex",
    kind: "turn",
    nativeLocation: "C:/project",
    nativeThreadId: fixtureIdentityValues.NativeThreadId["native-thread"],
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(`native-${turnId}`),
    startedAt: (turnIndex + 1) * 1_000,
    state: "completed",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
    turnIndex,
  };
}

function item(
  turnId: string,
  value: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["item"],
  observedAt: number,
  timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"],
): WorkbenchTranscriptAtomicObservation {
  return {
    item: value,
    kind: "item",
    lifecycle: "completed",
    observedAt,
    ...(timeline ? { timeline } : {}),
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
  };
}

function canonicalWindow(
  observations: WorkbenchTranscriptAtomicObservation[],
  materializedTurnIds: string[],
): WorkbenchTranscriptObservation {
  return {
    contentVersion: 3,
    kind: "canonicalWindow",
    materializedTurnIds: materializedTurnIds.map((id) => fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id)),
    observations,
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
  };
}

test("real SQLite rows project the renderer facts used by current command, file, interaction, and unknown displays", () => {
  const { database, repository } = createRepository();
  try {
    const fileChange: WorkbenchFileChangeItem = {
      changes: [{
        diff: "@@\n+sparkle",
        kind: { move_path: null, type: "update" },
        path: "src/sparkle.ts",
        workbenchAdditions: 1,
        workbenchDeletions: 0,
      }],
      id: "file",
      status: "completed",
      type: "fileChange",
    };
    const questionnaire: Extract<WorkbenchTranscriptAtomicObservation, { kind: "questionnaire" }>["entry"] = {
      insertAfterItemId: null,
      insertAfterItemIndex: null,
      itemId: null,
      request: {
        id: "request",
        questions: [{
          allowOther: true,
          header: "Choice",
          id: "choice",
          isSecret: false,
          options: [{ description: "First option", label: "One" }],
          question: "Pick one",
        }],
        submitLabel: "Submit",
        summary: "Choose",
        title: "Questionnaire",
      },
      requestKey: "request-key",
      resolvedAt: 6_000,
      response: { answers: { choice: { answers: ["One"] } } },
      threadId: fixtureIdentityValues.WorkbenchThreadId.thread,
      turnId: fixtureIdentityValues.WorkbenchTurnId["turn-1"],
    };
    repository.settle([canonicalWindow([
      thread(),
      turn("turn-0", 0),
      turn("turn-1", 1),
      item("turn-1", {
        clientId: "client",
        content: [{ text: "hello", text_elements: [], type: "text" }],
        id: "user",
        type: "userMessage",
      }, 2_000, {
        aliases: ["user-alias"],
        completedAt: 2_000,
        firstSeenAt: 1_900,
        itemId: "user",
        lastSeenAt: 2_000,
        startedAt: 1_950,
      }),
      item("turn-1", {
        content: ["hidden"],
        id: "reasoning",
        summary: ["visible"],
        type: "reasoning",
      }, 3_000),
      item("turn-1", {
        aggregatedOutput: "match",
        command: "rg sparkle src",
        commandActions: [{ command: "rg sparkle src", path: "src", query: "sparkle", type: "search" }],
        cwd: "C:/project",
        durationMs: 20,
        exitCode: 0,
        id: "command",
        pluginId: null,
        processId: "process",
        scriptPath: null,
        source: "agent",
        status: "completed",
        type: "commandExecution",
      }, 4_000),
      {
        entry: {
          action: "snapshot",
          actionIndex: 0,
          assetUrl: "/api/transcript-assets/codex/dGhyZWFk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
          commandItemId: "command",
          detailKind: "result",
          detailLabel: "Snapshot",
          detailText: "Captured",
          durationMs: 10,
          entryKey: "browse",
          recordedAt: 4_100,
          session: "research",
          state: "completed",
          threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
          turnId: fixtureIdentityValues.WorkbenchTurnId["turn-1"],
        },
        kind: "browse",
        asset: {
          byteLength: 12,
          digest: "a".repeat(64),
          mimeType: "image/png",
          storageKey: "/api/transcript-assets/codex/dGhyZWFk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        },
      },
      item("turn-1", {
        appContext: null,
        arguments: { path: "src" },
        durationMs: 30,
        error: null,
        id: "mcp",
        pluginId: null,
        readOnlyHint: true,
        result: {
          _meta: { source: "test" },
          content: [{ text: "done", type: "text" }],
          structuredContent: { ok: true },
        },
        server: "wb",
        status: "completed",
        tool: "shell",
        type: "mcpToolCall",
      }, 5_000),
      item("turn-1", fileChange, 5_500),
      { entry: questionnaire, kind: "questionnaire", observedAt: 6_000 },
      item("turn-1", { id: "opaque", path: "C:/project/image.png", type: "imageView" }, 7_000),
    ], ["turn-1"])]);

    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    const itemProjection = projectWorkbenchTranscriptItems(snapshot.rows);
    assert.equal(itemProjection.success, true);
    if (!itemProjection.success) return;
    const itemIdByReference = new Map(snapshot.rows.itemSourceAliases.map((source) => (
      [source.reference, source.item_identity_id]
    )));
    const itemId = (reference: string) => itemIdByReference.get(reference)!;
    assert.ok(itemProjection.data.every(({ item: projectedItem, root }) => projectedItem.id === root.public_id));
    assert.deepEqual(
      itemProjection.data.map(({ root }) => [
        snapshot.rows.itemSourceAliases.find((source) => source.item_identity_id === root.public_id)?.reference,
        root.item_position,
      ]),
      [
        ["user", 0],
        ["reasoning", 1],
        ["command", 2],
        ["mcp", 3],
        ["file", 4],
        ["workbench-questionnaire:thread:turn-1:request-key", 5],
        ["opaque", 6],
      ],
    );
    const result = projectWorkbenchTranscript(snapshot);
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.deepEqual(result.data.turnHistory.map(({ itemCount, loadState, turnId }) => ({
      itemCount,
      loadState,
      turnId,
    })), [
      { itemCount: 0, loadState: "unloaded", turnId: "turn-0" },
      { itemCount: 7, loadState: "loaded", turnId: "turn-1" },
    ]);
    assert.deepEqual(result.data.display.segments.map(({ items, turnId }) => ({
      itemIds: items.map(({ id }) => id),
      turnId,
    })), [
      { itemIds: ["user", "reasoning", "command", "mcp", "file", "workbench-questionnaire:thread:turn-1:request-key", "opaque"].map(itemId), turnId: "turn-1" },
    ]);
    assert.deepEqual(result.data.turns[0]?.itemTimeline, [{
      aliases: ["user-alias"],
      completedAt: 2_000,
      firstSeenAt: 1_900,
      itemId: itemId("user"),
      lastSeenAt: 2_000,
      startedAt: 1_950,
    }]);
    assert.deepEqual(result.data.browseResultEntries, [{
      action: "snapshot",
      actionIndex: 0,
      assetUrl: "/api/transcript-assets/codex/dGhyZWFk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      commandItemId: itemId("command"),
      detailKind: "result",
      detailLabel: "Snapshot",
      detailText: "Captured",
      durationMs: 10,
      entryKey: "browse",
      recordedAt: 4_100,
      session: "research",
      state: "completed",
      threadId: "thread",
      turnId: "turn-1",
    }]);
    const projected = result.data.turns[0]!.items;
    assert.deepEqual(projected.find(({ id }) => id === itemId("reasoning")), {
      content: [],
      id: itemId("reasoning"),
      summary: ["visible"],
      type: "reasoning",
    });
    assert.deepEqual(projected.find(({ id }) => id === itemId("mcp")), {
      appContext: null,
      arguments: { path: "src" },
      durationMs: 30,
      error: null,
      id: itemId("mcp"),
      pluginId: null,
      readOnlyHint: true,
      result: {
        _meta: { source: "test" },
        content: [{ text: "done", type: "text" }],
        structuredContent: { ok: true },
      },
      server: "wb",
      status: "completed",
      tool: "shell",
      type: "mcpToolCall",
    });
    assert.deepEqual(projected.find(({ id }) => id === itemId("file")), {
      ...fileChange,
      id: itemId("file"),
    });
    assert.deepEqual(projected.at(-1), {
      id: itemId("opaque"),
      nativeType: "imageView",
      safeValue: { id: "opaque", path: "C:/project/image.png", type: "imageView" },
      type: "generic",
    });
    const interaction = projected.find(({ type }) => type === "questionnaire");
    assert.ok(interaction?.type === "questionnaire");
    assert.deepEqual(interaction.request, questionnaire.request);
    assert.deepEqual(interaction.response, questionnaire.response);
  } finally {
    database.close();
  }
});

test("projection preserves distinct questionnaire items with one reused provider request key", () => {
  const { database, repository } = createRepository();
  const questionnaire = (
    turnId: string,
    itemId: string,
    resolvedAt: number,
  ): Extract<WorkbenchTranscriptAtomicObservation, { kind: "questionnaire" }>["entry"] => ({
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
    threadId: fixtureIdentityValues.WorkbenchThreadId.thread,
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
  });
  try {
    repository.settle([canonicalWindow([
      thread(),
      turn("older", 0),
      turn("newer", 1),
      { entry: questionnaire("older", "question-older", 2_000), kind: "questionnaire", observedAt: 2_000 },
      { entry: questionnaire("newer", "question-newer", 4_000), kind: "questionnaire", observedAt: 4_000 },
    ], ["older", "newer"])]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 2 });
    assert.ok(snapshot);
    const result = projectWorkbenchTranscript(snapshot);
    assert.equal(result.success, true);
    if (!result.success) return;

    const projectedItems = result.data.turns.flatMap(({ items }) => items);
    assert.equal(new Set(projectedItems.map(({ id }) => id)).size, 2);
    const sourceByItemId = new Map(snapshot.rows.itemSourceAliases.map((source) => (
      [source.item_identity_id, source.reference]
    )));
    assert.deepEqual(projectedItems.map(({ id }) => sourceByItemId.get(id)), ["question-older", "question-newer"]);
    assert.deepEqual(
      projectedItems.flatMap((item) => item.type === "questionnaire" ? [item.requestKey] : []),
      ["reused", "reused"],
    );
  } finally {
    database.close();
  }
});

test("projection reads an augmentation collection linearly as item count grows", () => {
  const { database, repository } = createRepository();
  try {
    const itemCount = 50;
    repository.settle([canonicalWindow([
      thread(),
      turn("turn-0", 0),
      ...Array.from({ length: itemCount }, (_, index) => item(
        "turn-0",
        {
          id: `message-${index}`,
          memoryCitation: null,
          delivery: null,
          questions: null,
          phase: null,
          text: `message ${index}`,
          type: "agentMessage",
        },
        2_000 + index,
      )),
    ], ["turn-0"])]);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    let rowReads = 0;
    const assistantMessages = snapshot.rows.threadItemAssistantMessages;
    snapshot.rows.threadItemAssistantMessages = new Proxy(assistantMessages, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = projectWorkbenchTranscript(snapshot);
    assert.equal(result.success, true);
    assert.ok(
      rowReads <= itemCount * 2,
      `projection rescanned the assistant-message collection: ${rowReads} row reads for ${itemCount} rows`,
    );
  } finally {
    database.close();
  }
});
