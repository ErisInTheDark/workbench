/*
 * No production exports. Tests protect incremental SQLite history, exact-turn materialisation, search, expansion, validation, and cancellation. Keywords: thread recall, SQLite, pagination, materialisation, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "workbench-shared/types";
import { installWorkbenchDatabaseSchema } from "../../../orchestrator/database/workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../../../orchestrator/database/transcript/WorkbenchTranscriptRepository.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "../../../orchestrator/database/transcript/workbench-transcript-types.ts";
import WorkbenchThreadRecallController from "./WorkbenchThreadRecallController";
import { createSqliteWorkbenchThreadRecallRef } from "./thread-context-recall.ts";

function thread(): WorkbenchTranscriptAtomicObservation {
  return {
    activityAt: 10,
    createdAt: 1,
    kind: "thread",
    projectId: "project",
    projectRoot: "C:/workspace",
    threadId: "thread-one",
    title: "Recall test",
    updatedAt: 10,
  };
}

function turn(turnId: string, turnIndex: number): WorkbenchTranscriptAtomicObservation {
  return {
    createdAt: turnIndex + 1,
    durationMs: 1,
    endedAt: turnIndex + 2,
    harnessId: "codex",
    kind: "turn",
    nativeLocation: "C:/workspace",
    nativeThreadId: "native-thread",
    nativeTurnId: turnId,
    startedAt: turnIndex + 1,
    state: "completed",
    threadId: "thread-one",
    turnId,
    turnIndex,
  };
}

function item(
  turnId: string,
  itemId: string,
  value: string,
  type: "agent" | "user",
): WorkbenchTranscriptAtomicObservation {
  return {
    item: type === "agent"
      ? {
        id: itemId,
        memoryCitation: null,
        phase: "commentary",
        text: value,
        type: "agentMessage",
      }
      : {
        clientId: null,
        content: [{ text: value, text_elements: [], type: "text" }],
        id: itemId,
        type: "userMessage",
      },
    itemPosition: 0,
    kind: "item",
    lifecycle: "completed",
    observedAt: 5,
    threadId: "thread-one",
    turnId,
  };
}

function window(
  observations: WorkbenchTranscriptAtomicObservation[],
  materializedTurnIds: string[],
): WorkbenchTranscriptObservation {
  return {
    contentVersion: 3,
    kind: "canonicalWindow",
    materializedTurnIds,
    observations,
    threadId: "thread-one",
  };
}

function createHarness({ seeded = true }: { seeded?: boolean } = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const oldTurn = turn("turn-old", 0);
  const newTurn = turn("turn-new", 1);
  const latestWindow = window([
    thread(),
    oldTurn,
    newTurn,
    item(
      "turn-new",
      "agent-new",
      `LATEST_HEAD_${"N".repeat(WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS + 2_000)}_LATEST_TAIL`,
      "agent",
    ),
  ], ["turn-new"]);
  if (seeded) repository.settle([latestWindow]);
  const materializations: Array<string | null> = [];
  const reads: Array<readonly string[] | undefined> = [];
  const projects: string[] = [];
  const controller = new WorkbenchThreadRecallController({
    materializeTurn: async (_threadId, turnId) => {
      materializations.push(turnId);
      if (turnId === null) {
        repository.settle([latestWindow]);
        return;
      }
      if (turnId !== "turn-old") throw new Error(`unexpected materialisation ${turnId}`);
      repository.settle([window([
        thread(),
        oldTurn,
        newTurn,
        item("turn-old", "user-old", "older matching user", "user"),
      ], ["turn-old"])]);
    },
    readTranscript: async (request) => {
      reads.push(request.turnIds);
      return repository.read(request);
    },
    resolveProjectFromCwd: async (cwd) => {
      projects.push(cwd);
    },
  });
  return {
    close: () => database.close(),
    controller,
    materializations,
    projects,
    reads,
  };
}

test("warm history stops after the newest SQLite turn fills the response", async () => {
  const harness = createHarness();
  try {
    const response = await harness.controller.execute({
      method: "GET",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, new AbortController().signal);
    const markdown = await response.text();
    assert.equal(response.status, 200);
    assert.match(markdown, /<commentary /u);
    assert(markdown.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
    assert.deepEqual(harness.reads, [[], ["turn-new"]]);
    assert.deepEqual(harness.materializations, []);
    assert.deepEqual(harness.projects, ["C:/workspace"]);
  } finally {
    harness.close();
  }
});

test("filtered history and expansion materialize only reached turns", async () => {
  const historyHarness = createHarness();
  try {
    const history = await historyHarness.controller.execute({
      method: "GET",
      searchParams: new URLSearchParams([["kind", "user-message"]]),
      threadId: "thread-one",
    }, new AbortController().signal);
    assert.equal(history.status, 200);
    assert.match(await history.text(), /older matching user/u);
    assert.deepEqual(historyHarness.materializations, ["turn-old"]);
    assert.deepEqual(historyHarness.reads, [
      [],
      ["turn-new"],
      ["turn-old"],
      ["turn-old"],
    ]);
  } finally {
    historyHarness.close();
  }

  const expansionHarness = createHarness();
  try {
    const ref = createSqliteWorkbenchThreadRecallRef({
      itemId: "user-old",
      turnId: "turn-old",
    });
    const expansion = await expansionHarness.controller.execute({
      body: { action: "expand", ref },
      method: "POST",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, new AbortController().signal);
    assert.equal(expansion.status, 200);
    assert.match(await expansion.text(), /older matching user/u);
    assert.deepEqual(expansionHarness.materializations, ["turn-old"]);
    assert.deepEqual(expansionHarness.reads, [[], ["turn-old"], ["turn-old"]]);
  } finally {
    expansionHarness.close();
  }
});

test("search scans all turns while invalid requests and cancellation avoid transcript work", async () => {
  const harness = createHarness();
  try {
    const search = await harness.controller.execute({
      body: { action: "search", query: "matching" },
      method: "POST",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, new AbortController().signal);
    assert.equal(search.status, 200);
    assert.match(await search.text(), /older matching user/u);
    assert.deepEqual(harness.materializations, ["turn-old"]);

    const readsBeforeInvalid = harness.reads.length;
    const invalid = await harness.controller.execute({
      body: { action: "search", query: "" },
      method: "POST",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, new AbortController().signal);
    assert.equal(invalid.status, 400);
    assert.equal(harness.reads.length, readsBeforeInvalid);

    const cancellation = new AbortController();
    cancellation.abort(new Error("cancelled"));
    await assert.rejects(harness.controller.execute({
      method: "GET",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, cancellation.signal), /cancelled/u);
    assert.equal(harness.reads.length, readsBeforeInvalid);
  } finally {
    harness.close();
  }
});

test("an unknown historical thread bootstraps only its latest stored turn and catalogue", async () => {
  const harness = createHarness({ seeded: false });
  try {
    const response = await harness.controller.execute({
      method: "GET",
      searchParams: new URLSearchParams(),
      threadId: "thread-one",
    }, new AbortController().signal);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.materializations, [null]);
    assert.deepEqual(harness.reads, [[], [], ["turn-new"]]);
  } finally {
    harness.close();
  }
});
