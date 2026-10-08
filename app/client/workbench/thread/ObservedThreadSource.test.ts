/*
 * No production exports. Protects the observed feed's optimistic overlay lifecycle and older-turn window paging.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { ThreadTranscriptLocalThread, ThreadTranscriptProjectionState } from "../transcript/ThreadTranscriptProjectionController";
import createObservedThreadSource, { type ObservedThreadSourcePorts } from "./ObservedThreadSource";
import type { ThreadStoreState } from "./ThreadStore";

const threadId = WorkbenchThreadIdSchema.parse("thread");

function projection(turns: Array<{ id: string; status?: string; clientIds?: string[] }>, hasPreviousTurns = false) {
  return {
    approvalEntries: [], browseResultEntries: [], questionnaireEntries: [], steerEntries: [],
    display: { orderedItems: [], segments: [] }, hasPreviousTurns, turnHistory: [],
    thread: { activityAt: 1, createdAt: 1, cwd: "C:/project", id: threadId, projectId: "project", projectRoot: "C:/project", title: "Thread", updatedAt: 1 },
    turns: turns.map((turn, turnIndex) => ({
      id: turn.id, status: turn.status ?? "completed", turnIndex, itemTimeline: [], error: null,
      startedAt: 1, completedAt: 2, durationMs: 1, itemsView: "full",
      items: (turn.clientIds ?? []).map(clientId => ({ type: "userMessage", id: `item-${clientId}`, clientId, content: [] })),
    })),
  } as unknown as WorkbenchTranscriptProjection;
}

function fixture(runtime: Record<string, object> = {}) {
  const selections: Array<{ thread: ThreadTranscriptLocalThread; turnLimit?: number }> = [];
  const submits: Array<{ clientMessageId: string }> = [];
  let onState!: (state: ThreadTranscriptProjectionState) => void;
  let resolveSubmit!: (result: { kind: "started"; turn: { id: string } } | { kind: "steered"; turnId: string }) => void;
  let published: Partial<ThreadStoreState> = {};
  const entry = {
    activityAt: 1, title: "Thread", entryKind: "thread", identity: { harness: "codex", threadId },
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  };
  const ports = {
    projectId: "project",
    target: { kind: "provider", harness: "codex", threadId },
    observations: {
      acquire: () => ({ key: "key", release: () => {} }),
      getSnapshot: () => ({ status: "ready", error: null, observation: { entries: [entry], runtime } }),
      getSubagents: () => [],
    },
    daemon: { threads: { message: async (input: { clientMessageId: string }) => {
      submits.push(input);
      return await new Promise(resolve => { resolveSubmit = resolve; });
    } } },
    connect: async () => {},
    createTranscript: (state: typeof onState) => {
      onState = state;
      // Like the real controller, availability publishes during construction.
      state({ status: "idle" });
      return { controller: { select: (selection: (typeof selections)[number]) => { selections.push(selection); }, dispose: async () => {} }, stopAvailability: () => {} };
    },
    presentText: () => {},
    messageContext: () => ({}),
    readRateLimits: () => null,
    watchRateLimits: () => {},
    subscribeRateLimits: () => () => {},
    updateThreadStateWithAcceptance: async () => true,
    reportError: () => {},
  } as unknown as ObservedThreadSourcePorts;
  const source = createObservedThreadSource(ports, next => { published = { ...published, ...next }; });
  const release = source.acquire("view");
  return {
    source, release, selections, submits,
    publish: (value: WorkbenchTranscriptProjection) => onState({ status: "ready", threadId, projection: value }),
    resolveSubmit: (result: Parameters<typeof resolveSubmit>[0]) => resolveSubmit(result),
    get published() { return published; },
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("the thread head shows the goal and active skills its observation runtime carries", () => {
  const goal = { objective: "ship the port", updatedAt: 3 };
  const skills = [{ path: "skills/react/SKILL.md", name: "react", source: "user" as const, activatedAt: 1 }];
  const f = fixture({ [threadId]: { tokenUsage: null, willAutoCompact: null, goal, skills } });
  assert.deepEqual(f.published.summary?.head?.goal, goal);
  assert.deepEqual(f.published.summary?.head?.skills, skills);
  f.release();
  const bare = fixture({ [threadId]: { tokenUsage: null, willAutoCompact: null } });
  assert.equal(bare.published.summary?.head?.goal, null, "a daemon without goals shows none");
  assert.deepEqual(bare.published.summary?.head?.skills, []);
  bare.release();
});

test("an optimistic input stays local until the transcript delivers it, then leaves no duplicate", async () => {
  const f = fixture();
  f.publish(projection([{ id: "turn-1" }]));
  const sending = f.source.actions.send([{ type: "text", text: "hello", text_elements: [] }]);
  await flush();
  const clientId = f.submits[0]!.clientMessageId;
  const pendingSelection = f.selections.at(-1)!;
  assert.equal(pendingSelection.thread.turns.length, 1);
  assert.equal(pendingSelection.thread.turns[0]!.items[0]?.type === "userMessage" && pendingSelection.thread.turns[0]!.items[0].clientId, clientId);

  f.resolveSubmit({ kind: "started", turn: { id: "turn-2" } });
  await sending;
  // Admission alone keeps the overlay: the transcript has not carried the input yet.
  assert.equal(f.selections.at(-1)!.thread.turns.length, 1);

  const selectionsBeforeDelivery = f.selections.length;
  f.publish(projection([{ id: "turn-1" }, { id: "turn-2", status: "inProgress", clientIds: [clientId] }]));
  assert.equal(f.selections.length, selectionsBeforeDelivery + 1);
  assert.deepEqual(f.selections.at(-1)!.thread.turns, []);
  f.release();
});

test("a failed submission drops its optimistic input and reports the failure", async () => {
  const f = fixture();
  f.publish(projection([{ id: "turn-1" }]));
  const ports = f.source.actions;
  const sending = ports.send([{ type: "text", text: "hello", text_elements: [] }]);
  await flush();
  assert.equal(f.selections.at(-1)!.thread.turns.length, 1);
  f.resolveSubmit(Promise.reject(new Error("offline")) as never);
  await assert.rejects(sending, /offline/u);
  assert.deepEqual(f.selections.at(-1)!.thread.turns, []);
  f.release();
});

test("loading older turns widens the window and resolves with only the newly loaded turns", async () => {
  const f = fixture();
  f.publish(projection([{ id: "turn-3" }, { id: "turn-4" }], true));
  const firstLimit = f.selections.at(-1)!.turnLimit!;
  const loading = f.source.actions.loadOlder();
  assert.ok(f.selections.at(-1)!.turnLimit! > firstLimit);
  f.publish(projection([{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }, { id: "turn-4" }]));
  assert.deepEqual(await loading, ["turn-1", "turn-2"]);
  assert.equal(f.published.turns?.canLoadOlder, false);
  f.release();
});
