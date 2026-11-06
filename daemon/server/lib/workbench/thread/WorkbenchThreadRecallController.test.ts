/* Exports: none. Tests protect bounded narrative pages, provider recovery limits, search output and request validation. */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "workbench-shared/types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
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

function filing(turnId: string, itemId: string, itemPosition: number, args: JsonValue): ItemObservation {
  return {
    item: {
      appContext: null, arguments: args, durationMs: null, error: null, id: itemId, pluginId: null, readOnlyHint: null,
      result: null, server: "wb", status: "completed", tool: "thread_state", type: "mcpToolCall",
    },
    itemPosition, kind: "item", lifecycle: "completed", observedAt: 5,
    threadId, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
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
  latestItems,
}: { seeded?: boolean; latestText?: string; failRecovery?: boolean; latestItems?: ItemObservation[] } = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const index = new WorkbenchHistoryIndex(database);
  const latestWindow = window([thread(), turn("turn-old", 0), turn("turn-new", 1), ...latestItems ?? [item("turn-new", "agent-new", latestText, "agent")]], ["turn-new"]);
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
      database.prepare("DELETE FROM thread_turn_payload_retention WHERE turn_id = ?").run(oldTurn.turnId);
      database.prepare("DELETE FROM thread_turn_materializations WHERE turn_id = ?").run(oldTurn.turnId);
      repository.settle([window([
        thread(owner), { ...turn("turn-old", 0, owner), turnId: oldTurn.turnId },
        { ...item("turn-old", "user-old", "older matching user", "user", owner), turnId: oldTurn.turnId },
      ], [oldTurn.turnId], owner)]);
    },
    readThread: async (id) => {
      const stored = repository.read({ threadId: id, turnIds: [], turnLimit: 1 })?.thread;
      return stored ? { id: stored.id, projectRoot: stored.project_root } : null;
    },
    readHiddenChecklists: async () => [{ id: "recovery", hidden: true, items: [{ id: "recovery.user_said", label: "What has the user said" }] }],
    resolveProjectFromCwd: async () => {},
  });
  const canonicalId = () => canonical()?.threadId ?? "thread-one";
  const get = async (params: Record<string, string> = {}, relayed = false) => await controller.execute({
    method: "GET", relayed, searchParams: new URLSearchParams(params), threadId: canonicalId(),
  }, new AbortController().signal);
  const search = async (body: unknown) => await controller.execute({
    body, method: "POST", searchParams: new URLSearchParams(), threadId: canonicalId(),
  }, new AbortController().signal);
  return { close: () => database.close(), database, get, index, materializations, queries: () => queries, search };
}

test("recall shows filed proofs in order, by kind, by ref and by search, without hidden checklists or proofless calls", async () => {
  const harness = createHarness({ latestItems: [
    { ...item("turn-new", "agent-before", "words before filing", "agent"), itemPosition: 0 },
    filing("turn-new", "filing-visible", 1, { proofs: { "plan.verification": "zebrafinding", "recovery.user_said": "hiddentonenote" }, notApplicable: ["plan.dead_code"] }),
    filing("turn-new", "filing-hidden", 2, { proofs: { "recovery.user_said": "onlyhiddennote" } }),
    filing("turn-new", "filing-none", 3, { mode: "Brief" }),
    { ...item("turn-new", "agent-after", "words after filing", "agent"), itemPosition: 4 },
  ] });
  try {
    const page = await (await harness.get()).text();
    const opening = page.indexOf("<proof-of-work ");
    assert.ok(page.indexOf("words before filing") < opening && opening < page.indexOf("words after filing"), page);
    assert.equal(page.split("<proof-of-work ").length, 2, "only the filing with visible proofs is a record");
    assert.match(page, /- \*\*plan\.verification:\*\* zebrafinding/u);
    assert.match(page, /Not applicable: plan\.dead_code/u);
    assert.doesNotMatch(page, /hiddentonenote|onlyhiddennote/u);

    const filtered = await (await harness.get({ kind: "proof-of-work" })).text();
    assert.match(filtered, /zebrafinding/u);
    assert.doesNotMatch(filtered, /words before filing/u);

    const ref = /<proof-of-work id="ref:([^"]+)"/u.exec(page)![1]!;
    assert.match(await (await harness.get({ around: ref })).text(), /zebrafinding/u);

    assert.match(await (await harness.search({ action: "search", query: "zebrafinding" })).text(), /<proof-of-work [^>]*>\n[^\n]*zebrafinding/u);
    assert.doesNotMatch(await (await harness.search({ action: "search", query: "onlyhiddennote" })).text(), /<proof-of-work /u);
  } finally { harness.close(); }
});

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

function oldTurnOf(harness: ReturnType<typeof createHarness>) {
  return harness.database.prepare("SELECT id FROM thread_turns WHERE turn_index = 0").pluck().get() as string;
}

/** The first read stores the old turn through ordinary recovery; retention then removes its payload. */
async function expireOldTurn(harness: ReturnType<typeof createHarness>) {
  await harness.get();
  const oldTurnId = oldTurnOf(harness);
  harness.database.prepare("INSERT INTO thread_turn_payload_retention(turn_id, expired_at) VALUES (?, 1)").run(oldTurnId);
  harness.database.prepare("DELETE FROM thread_items WHERE turn_id = ?").run(oldTurnId);
  harness.materializations.length = 0;
  return oldTurnId;
}

test("naming an expired turn recovers it and links its neighbours; unscoped walks only offer the command", async () => {
  const harness = createHarness();
  try {
    const oldTurnId = await expireOldTurn(harness);
    const unscoped = await (await harness.get()).text();
    assert.deepEqual(harness.materializations, []);
    assert.ok(unscoped.includes(`--turn ${oldTurnId}`), unscoped);
    assert.doesNotMatch(unscoped, /wb transcript/u);

    const named = await (await harness.get({ turn: oldTurnId })).text();
    assert.deepEqual(harness.materializations, ["turn-old"]);
    assert.match(named, /older matching user/u);
    assert.doesNotMatch(named, /latest agent words/u);
    assert.match(named, /Newer turn: `wb thread recall --thread \S+ --turn \S+`/u);
    assert.doesNotMatch(named, /Older turn:/u);
  } finally { harness.close(); }
});

test("a relayed caller never recovers an expired turn", async () => {
  const harness = createHarness();
  try {
    const oldTurnId = await expireOldTurn(harness);
    const text = await (await harness.get({ turn: oldTurnId }, true)).text();
    assert.deepEqual(harness.materializations, []);
    assert.match(text, /own daemon/u);
  } finally { harness.close(); }
});

test("a failed recovery of a named turn still links its neighbours", async () => {
  const harness = createHarness({ failRecovery: true });
  try {
    await harness.get();
    const response = await harness.get({ turn: oldTurnOf(harness) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /Provider recovery failed/u);
    assert.match(text, /Newer turn:/u);
  } finally { harness.close(); }
});

test("search admits that expired turns are outside its reach", async () => {
  const harness = createHarness();
  try {
    await expireOldTurn(harness);
    while (harness.index.backfillStep());
    const text = await (await harness.search({ action: "search", query: "nothing-like-this" })).text();
    assert.match(text, /1 turn\(s\) expired by retention/u);
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
