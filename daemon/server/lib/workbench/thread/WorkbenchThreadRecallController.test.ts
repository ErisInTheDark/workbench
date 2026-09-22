/* Exports: none. Tests protect incremental SQLite history, exact-turn materialisation, search, expansion, validation, and cancellation. */
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
import WorkbenchThreadRecallController, {
  type WorkbenchThreadRecallControllerOptions,
} from "./WorkbenchThreadRecallController";
import { createSqliteWorkbenchThreadRecallRef, createWorkbenchThreadRecallCursor } from "./thread-context-recall.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread"),
  },
  ProjectId: {
    "project": testProjectIds.project,
  },
  WorkbenchThreadId: {
    "thread-one": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"),
  },
};

type ThreadObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" }>;
type TurnObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }>;
type ItemObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>;

function thread(): ThreadObservation {
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

function turn(turnId: string, turnIndex: number): TurnObservation {
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
): ItemObservation {
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
  threadId: ThreadObservation["threadId"] = fixtureIdentityValues.WorkbenchThreadId["thread-one"],
): WorkbenchTranscriptObservation {
  return {
    contentVersion: 3,
    kind: "canonicalWindow",
    materializedTurnIds: materializedTurnIds.map((id) => fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id)),
    observations,
    threadId,
  };
}

function createReferenceResolver(
  database: Database.Database,
  readTranscript: (
    request: Parameters<WorkbenchTranscriptRepository["read"]>[0],
  ) => Promise<ReturnType<WorkbenchTranscriptRepository["read"]>>,
  materializeTurn: (threadId: string, turnId: string | null) => Promise<void>,
): NonNullable<WorkbenchThreadRecallControllerOptions["resolveReference"]> {
  const threads = new WorkbenchThreadIdentityRepository(database);
  const items = new WorkbenchTranscriptIdentityRepository(database);
  return async (threadId, reference) => {
    const canonicalThread = threads.resolve({
      threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse(threadId),
    });
    assert.ok(canonicalThread);
    const canonicalThreadId = canonicalThread.threadId;
    const turn = threads.resolveTurn({
      threadId: canonicalThreadId,
      turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse(reference.turnId),
    });
    assert.ok(turn);
    let snapshot = await readTranscript({ threadId: canonicalThreadId, turnIds: [turn.turnId], turnLimit: 1 });
    if (!snapshot) {
      await materializeTurn(canonicalThreadId, turn.turnId);
      snapshot = await readTranscript({ threadId: canonicalThreadId, turnIds: [turn.turnId], turnLimit: 1 });
    }
    assert.ok(snapshot);
    const item = items.resolve({
      threadId: canonicalThreadId,
      turnId: turn.turnId,
      itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(reference.itemId),
    });
    assert.ok(item);
    return { ...reference, turnId: turn.turnId, itemId: item.itemId };
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
  const readTranscript = async (request: Parameters<WorkbenchTranscriptRepository["read"]>[0]) => {
    reads.push(request.turnIds);
    return repository.read(request);
  };
  const materializeTurn = async (_threadId: string, turnId: string | null) => {
    const identities = new WorkbenchThreadIdentityRepository(database);
    const canonicalThread = identities.resolve({
      threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread-one"),
    });
    const canonicalOldTurnId = canonicalThread && identities.resolveTurn({
      threadId: canonicalThread.threadId,
      turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse("turn-old"),
    })?.turnId;
    const materializedTurnId = canonicalOldTurnId && turnId === canonicalOldTurnId ? "turn-old" : turnId;
    materializations.push(materializedTurnId);
    if (turnId === null) {
      repository.settle([latestWindow]);
      return;
    }
    if (materializedTurnId !== "turn-old") throw new Error(`unexpected materialisation ${turnId}`);
    assert.ok(canonicalThread);
    const materializedOldTurn = canonicalOldTurnId
      ? { ...oldTurn, threadId: canonicalThread.threadId, turnId: canonicalOldTurnId }
      : oldTurn;
    const materializedOldItem = {
      ...item("turn-old", "user-old", "older matching user", "user"),
      threadId: canonicalThread.threadId,
      turnId: materializedOldTurn.turnId,
    };
    const materializedWindow = window([
      { ...thread(), threadId: canonicalThread.threadId },
      materializedOldTurn,
      materializedOldItem,
    ], [materializedOldTurn.turnId], canonicalThread.threadId);
    repository.settle([materializedWindow]);
  };
  const controller = new WorkbenchThreadRecallController({
    materializeTurn,
    readTranscript,
    resolveProjectFromCwd: async (cwd) => {
      projects.push(cwd);
    },
    resolveReference: createReferenceResolver(database, readTranscript, materializeTurn),
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
  const controller = new WorkbenchThreadRecallController({
    materializeTurn: async () => { throw new Error("Converted warm Recall must not read provider history"); },
    readTranscript: async (input) => repository.read(input),
    resolveProjectFromCwd: async () => {},
    resolveReference: createReferenceResolver(reopened, async input => repository.read(input), async () => {
      throw new Error("Converted warm Recall must not read provider history");
    }),
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
    const historyText = await history.text();
    assert.equal(history.status, 200, historyText);
    assert.match(historyText, /older matching user/u);
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
    const expansionText = await expansion.text();
    assert.equal(expansion.status, 200, expansionText);
    assert.match(expansionText, /older matching user/u);
    assert.deepEqual(expansionHarness.materializations, ["turn-old"]);
    assert.equal(expansionHarness.reads.length, 4);
    assert.deepEqual(expansionHarness.reads[0], []);
    assert.equal(expansionHarness.reads[1]?.length, 1);
    assert.deepEqual(expansionHarness.reads[2], expansionHarness.reads[1]);
    assert.deepEqual(expansionHarness.reads[3], expansionHarness.reads[1]);
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
    const searchText = await search.text();
    assert.equal(search.status, 200, searchText);
    assert.match(searchText, /older matching user/u);
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
