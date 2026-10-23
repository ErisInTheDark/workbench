/* Exports: none. Tests protect bounded narrative pages, provider recovery limits, search output and request validation. */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "workbench-shared/types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import WorkbenchHistoryIndex from "../../../database/history/WorkbenchHistoryIndex.ts";
import WorkbenchHistoryQueryRepository from "../../../database/history/WorkbenchHistoryQueryRepository.ts";
import WorkbenchThreadIdentityRepository from "../../../database/thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptRepository from "../../../database/transcript/WorkbenchTranscriptRepository.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "../../../database/transcript/workbench-transcript-types.ts";
import { installWorkbenchDatabaseSchema } from "../../../database/workbench-database-schema.ts";
import WorkbenchThreadRecallController from "./WorkbenchThreadRecallController";

type ThreadObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" }>;
type TurnObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }>;
type ItemObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>;

const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one");

function thread(id = threadId): ThreadObservation {
  return {
    activityAt: 10, createdAt: 1, kind: "thread", projectId: testProjectIds.project,
    projectRoot: "C:/workspace", threadId: id, title: "Recall test", updatedAt: 10,
  };
}

function turn(turnId: string, turnIndex: number, id = threadId): TurnObservation {
  return {
    createdAt: turnIndex + 1, durationMs: 1, endedAt: turnIndex + 2, harnessId: "codex", kind: "turn",
    nativeLocation: "C:/workspace", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread"),
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId), startedAt: turnIndex + 1, state: "completed",
    threadId: id, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), turnIndex,
  };
}

function item(turnId: string, itemId: string, value: string, type: "agent" | "user", id = threadId): ItemObservation {
  return {
    item: type === "agent"
      ? { id: itemId, memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: value, type: "agentMessage" }
      : { clientId: null, content: [{ text: value, text_elements: [], type: "text" }], id: itemId, type: "userMessage" },
    itemPosition: 0, kind: "item", lifecycle: "completed", observedAt: 5,
    threadId: id, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
  };
}

function window(observations: WorkbenchTranscriptAtomicObservation[], materializedTurnIds: string[], id = threadId): WorkbenchTranscriptObservation {
  return {
    contentVersion: 3, kind: "canonicalWindow", observations, threadId: id,
    materializedTurnIds: materializedTurnIds.map(turnId => fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId)),
  };
}

function createHarness({
  seeded = true,
  latestText = "latest agent words",
  failRecovery = false,
}: { seeded?: boolean; latestText?: string; failRecovery?: boolean } = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const index = new WorkbenchHistoryIndex(database);
  const latestWindow = window([thread(), turn("turn-old", 0), turn("turn-new", 1), item("turn-new", "agent-new", latestText, "agent")], ["turn-new"]);
  if (seeded) repository.settle([latestWindow]);
  const materializations: Array<string | null> = [];
  let queries = 0;
  const canonical = () => new WorkbenchThreadIdentityRepository(database).resolve({ threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread-one") });
  const controller = new WorkbenchThreadRecallController({
    queryHistory: async (query) => {
      queries += 1;
      return new WorkbenchHistoryQueryRepository(database, index).read(query);
    },
    materializeTurn: async (storedThreadId, turnId) => {
      if (turnId === null) {
        materializations.push(null);
        repository.settle([latestWindow]);
        return;
      }
      const owner = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(storedThreadId);
      const oldTurn = new WorkbenchThreadIdentityRepository(database).resolveTurn({
        threadId: owner, turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse("turn-old"),
      })!;
      materializations.push(turnId === oldTurn.turnId ? "turn-old" : turnId);
      if (failRecovery) throw new Error("provider unavailable");
      repository.settle([window([
        thread(owner), { ...turn("turn-old", 0, owner), turnId: oldTurn.turnId },
        { ...item("turn-old", "user-old", "older matching user", "user", owner), turnId: oldTurn.turnId },
      ], [oldTurn.turnId], owner)]);
    },
    readThread: async (id) => {
      const stored = repository.read({ threadId: id, turnIds: [], turnLimit: 1 })?.thread;
      return stored ? { id: stored.id, projectRoot: stored.project_root } : null;
    },
    resolveProjectFromCwd: async () => {},
  });
  const canonicalId = () => canonical()?.threadId ?? "thread-one";
  const get = async (params: Record<string, string> = {}) => await controller.execute({
    method: "GET", searchParams: new URLSearchParams(params), threadId: canonicalId(),
  }, new AbortController().signal);
  const search = async (body: unknown) => await controller.execute({
    body, method: "POST", searchParams: new URLSearchParams(), threadId: canonicalId(),
  }, new AbortController().signal);
  return { close: () => database.close(), database, get, index, materializations, queries: () => queries, search };
}

test("an oversized newest record splits inside the budget and its older continuation resumes the unshown head", async () => {
  const harness = createHarness({ latestText: `LATEST_HEAD\n${"N".repeat(WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS + 2_000)}\nLATEST_TAIL` });
  try {
    const first = await (await harness.get()).text();
    assert.ok(first.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
    assert.match(first, /LATEST_TAIL/u);
    assert.doesNotMatch(first, /LATEST_HEAD/u);
    const older = /Older: `wb thread recall --thread \S+ --before (\S+@\d+)`/u.exec(first)?.[1];
    assert.ok(older, first.slice(0, 600));
    const second = await (await harness.get({ before: older })).text();
    assert.match(second, /LATEST_HEAD/u);
    assert.doesNotMatch(second, /LATEST_TAIL/u);
  } finally { harness.close(); }
});

test("a never-materialised turn in the window is recovered once, then read from storage", async () => {
  const harness = createHarness();
  try {
    const text = await (await harness.get()).text();
    assert.match(text, /older matching user/u);
    assert.deepEqual(harness.materializations, ["turn-old"]);
    await harness.get();
    assert.deepEqual(harness.materializations, ["turn-old"]);
  } finally { harness.close(); }
});

test("retention-expired turns are never recovered from the provider and the page says so", async () => {
  const harness = createHarness();
  try {
    await harness.get();
    harness.database.prepare(`INSERT INTO thread_turn_payload_retention(turn_id, expired_at)
      SELECT turn_id, 1 FROM thread_items WHERE id = (SELECT MIN(id) FROM thread_items WHERE type = 'userMessage')`).run();
    harness.database.prepare("DELETE FROM thread_items WHERE type = 'userMessage'").run();
    const text = await (await harness.get()).text();
    assert.match(text, /expired by retention/u);
    assert.deepEqual(harness.materializations, ["turn-old"]);
  } finally { harness.close(); }
});

test("a failed provider recovery still renders the page and names the failure", async () => {
  const harness = createHarness({ failRecovery: true });
  try {
    const response = await harness.get();
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /latest agent words/u);
    assert.match(text, /Provider recovery failed for turn .*provider unavailable/u);
  } finally { harness.close(); }
});

test("search matches words in any order and prints an around command, while invalid requests do no work", async () => {
  const harness = createHarness();
  try {
    while (harness.index.backfillStep());
    const response = await harness.search({ action: "search", query: "words latest" });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /latest agent words/u);
    assert.match(text, /Context: `wb thread recall --thread \S+ --around \S+`/u);
    const before = harness.queries();
    const invalid = await harness.search({ action: "search", query: "" });
    assert.equal(invalid.status, 400);
    assert.equal(harness.queries(), before);
  } finally { harness.close(); }
});

test("an unknown historical thread bootstraps through one null-turn materialisation", async () => {
  const harness = createHarness({ seeded: false });
  try {
    const response = await harness.get();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(harness.materializations[0], null);
  } finally { harness.close(); }
});
