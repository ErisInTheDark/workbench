/*
 * No production exports. Tests protect incremental SQLite history, exact-turn materialisation, search, expansion, validation, and cancellation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "workbench-shared/types";
import { installWorkbenchDatabaseSchema } from "../../../database/workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../../../database/transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchThreadIdentityRepository from "../../../database/thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "../../../database/transcript/WorkbenchTranscriptIdentityRepository.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "../../../database/transcript/workbench-transcript-types.ts";
import WorkbenchThreadRecallController from "./WorkbenchThreadRecallController";
import { createSqliteWorkbenchThreadRecallRef, createWorkbenchThreadRecallCursor } from "./thread-context-recall.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "thread-one": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"),
  },
};

function thread(): WorkbenchTranscriptAtomicObservation {
  return {
    activityAt: 10,
    createdAt: 1,
    kind: "thread",
    projectId: fixtureIdentityValues.ProjectId["project"],
    projectRoot: "C:/workspace",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread-one"],
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
    nativeThreadId: fixtureIdentityValues.NativeThreadId["native-thread"],
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId),
    startedAt: turnIndex + 1,
    state: "completed",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread-one"],
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
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
        delivery: null,
        questions: null,
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
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread-one"],
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
  };
}

function window(
  observations: WorkbenchTranscriptAtomicObservation[],
  materializedTurnIds: string[],
): WorkbenchTranscriptObservation {
  return {
    contentVersion: 3,
    kind: "canonicalWindow",
    materializedTurnIds: materializedTurnIds.map((id) => fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id)),
    observations,
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread-one"],
  };
}

function createHarness({
  seeded = true,
  latestText = `LATEST_HEAD_${"N".repeat(WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS + 2_000)}_LATEST_TAIL`,
}: { seeded?: boolean; latestText?: string } = {}) {
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
      latestText,
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
    database,
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

test("retained Recall references and cursor offsets survive identity conversion and database reopen", async () => {
  const latestText = Array.from({ length: 8_000 }, (_, index) => `record ${index}\n`).join("");
  const harness = createHarness({ latestText });
  const oldRef = createSqliteWorkbenchThreadRecallRef({ turnId: "turn-new", itemId: "agent-new" });
  const cursor = createWorkbenchThreadRecallCursor(oldRef, 100);
  const request = {
    body: { action: "expand", ref: oldRef, cursor },
    method: "POST" as const, searchParams: new URLSearchParams(), threadId: "thread-one",
  };
  const oldResponse = await harness.controller.execute(request, new AbortController().signal);
  const oldText = await oldResponse.text();
  const identity = new WorkbenchThreadIdentityRepository(harness.database).resolve({ threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread-one") });
  assert.ok(identity);
  const reopened = new Database(harness.database.serialize());
  reopened.pragma("foreign_keys = ON");
  harness.close();
  const repository = new WorkbenchTranscriptRepository(reopened);
  const threads = new WorkbenchThreadIdentityRepository(reopened);
  const items = new WorkbenchTranscriptIdentityRepository(reopened);
  const controller = new WorkbenchThreadRecallController({
    materializeTurn: async () => { throw new Error("Converted warm Recall must not read provider history"); },
    readTranscript: async (input) => repository.read(input),
    resolveProjectFromCwd: async () => {},
    resolveReference: async (threadId, reference) => {
      const turn = threads.resolveTurn({ threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse(reference.turnId) });
      assert.ok(turn);
      repository.read({ threadId, turnIds: [turn.turnId], turnLimit: 1 });
      const item = items.resolve({ threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: turn.turnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(reference.itemId) });
      assert.ok(item);
      return { ...reference, turnId: turn.turnId, itemId: item.itemId };
    },
  });
  try {
    const response = await controller.execute({ ...request, threadId: identity.threadId }, new AbortController().signal);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /start="100"/u);
    const body = (markdown: string) => markdown.match(/start="100"[^>]*>\n([\s\S]*?)\n<\/commentary>/u)?.[1];
    for (const markdown of [oldText, text]) {
      const content = body(markdown);
      assert.ok(content);
      assert.equal(content, latestText.slice(100, 100 + content.length));
    }
    assert.ok(text.includes(identity.threadId));
    assert.equal(text.includes(oldRef), false);
  } finally { reopened.close(); }
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
