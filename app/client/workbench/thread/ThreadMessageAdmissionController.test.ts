/* Exports: none. Protect optimistic admission, exact ownership and accepted delivery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadPayload } from "workbench-shared/types";
import type { WorkbenchThreadMessage, WorkbenchThreadMessageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import ThreadDocumentStore from "../state/ThreadDocumentStore.ts";
import ThreadSourceStore from "../state/ThreadSourceStore.ts";
import ThreadOptimisticInputStore from "./ThreadOptimisticInputStore.ts";
import ThreadMessageAdmissionController, { type ThreadMessageAdmissionLifecycleState } from "./ThreadMessageAdmissionController.ts";
import { ThreadMessageNotSentError } from "./thread-message-submission.ts";

const input = [{ text: "message", text_elements: [], type: "text" as const }];
function thread(): Extract<ThreadPayload, { isDraft: false }> {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    harness: "codex", id: WorkbenchThreadIdSchema.parse("thread"), isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "active", tokenUsage: null, turnHistory: [],
    turns: [{ completedAt: null, durationMs: null, error: null, id: "turn", items: [], itemsView: "full", startedAt: 1, status: "inProgress" }], updatedAt: 1,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(options: {
  connect?: () => Promise<void>;
  submit?: (message: WorkbenchThreadMessage) => Promise<WorkbenchThreadMessageResult>;
  deliveredAfterFailure?: boolean;
  context?: WorkbenchMessageContext;
  renderFailure?: boolean;
} = {}) {
  const documents = ThreadDocumentStore();
  const sources = ThreadSourceStore();
  let nextId = 0;
  const optimisticInputs = ThreadOptimisticInputStore({ createClientUserMessageId: () => `message-${++nextId}` });
  sources.install(thread());
  documents.upsertDocument(thread(), { select: true });
  const lifecycle: ThreadMessageAdmissionLifecycleState = {
    disposed: false, messageAdmissionIntentRevision: 1, projectContextGeneration: 1,
    projectId: ProjectIdSchema.parse("project"), projectRootPath: "C:/repo",
  };
  const messages: WorkbenchThreadMessage[] = [];
  const events: string[] = [];
  const controller = ThreadMessageAdmissionController({
    client: {
      connect: options.connect ?? (async () => { events.push("connect"); }),
      submit: async message => {
        messages.push(message);
        return options.submit ? options.submit(message) : { kind: "steered", turnId: "turn" };
      },
    },
    documents, sources, optimisticInputs,
    emitWarning: message => events.push(`warning:${message}`),
    getLifecycleState: () => ({ ...lifecycle }),
    getThreadStatus: value => value.status,
    renderSource: () => {
      if (options.renderFailure) throw new Error("render failed");
      events.push("render");
    },
  });
  const projection = {
    context: options.context,
    projectFailedTurn: () => {
      events.push("failed");
      return options.deliveredAfterFailure ? WorkbenchTurnIdSchema.parse("delivered") : null;
    },
    projectPendingTurn: () => { events.push("pending"); },
    projectStartedTurn: () => { events.push("started"); },
    projectSteeredTurn: ({ turnId }: { turnId: string }) => { events.push(`steered:${turnId}`); },
  };
  return {
    controller, documents, sources, optimisticInputs, lifecycle, messages, events, projection,
    admit: () => controller.admit("thread", input, projection),
    idle: () => sources.update("codex:thread", source => ({ ...source, status: "idle", turns: [] })),
  };
}

test("active and waiting threads preserve content, context and expected-turn intent", async () => {
  for (const status of ["active", "active:waitingOnUserInput"]) {
    const context = { activatedSkillPaths: ["C:/skills/review/SKILL.md"] };
    const f = setup({ context });
    f.sources.update("codex:thread", source => ({ ...source, status }));
    assert.equal((await f.admit()).kind, "admitted");
    assert.deepEqual(f.messages, [{
      intent: "steer", threadId: "thread", expectedTurnId: "turn",
      clientMessageId: "message-1", input, context,
    }]);
    assert.deepEqual(f.events, ["connect", "render"]);
  }
});

test("idle admission projects pending input before starting or steering through the daemon", async () => {
  for (const kind of ["started", "steered"] as const) {
    const f = setup({ submit: async () => kind === "started"
      ? { kind, turn: { ...thread().turns[0]!, id: "new-turn" } }
      : { kind, turnId: "current-turn" } });
    f.idle();
    assert.equal((await f.admit()).kind, kind === "started" ? "turnStarted" : "admitted");
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].intent, "continue");
    assert.deepEqual(f.events, ["connect", "pending", kind === "started" ? "started" : "steered:current-turn"]);
  }
});

test("detached explicit new-turn intent survives unrelated selection changes", async () => {
  const connection = deferred<void>();
  const f = setup({ connect: () => connection.promise, submit: async () => ({ kind: "started", turn: thread().turns[0]! }) });
  const other = { ...thread(), id: WorkbenchThreadIdSchema.parse("other") };
  f.sources.install(other);
  f.documents.upsertDocument(other, { select: true });
  const admission = f.controller.admit("thread", input, f.projection, {
    selectionBound: false, startNewTurn: true, threadKey: "codex:thread",
  });
  f.lifecycle.messageAdmissionIntentRevision++;
  connection.resolve();
  assert.equal((await admission).kind, "turnStarted");
  assert.equal(f.messages[0].intent, "newTurn");
  assert.equal(f.messages[0].threadId, "thread");
});

test("connection-time activity changes choose the latest source without a second admission", async () => {
  for (const becomesActive of [false, true]) {
    const connection = deferred<void>();
    const f = setup({ connect: () => connection.promise });
    if (becomesActive) f.idle();
    const admission = f.admit();
    if (becomesActive) f.sources.install(thread());
    else f.idle();
    connection.resolve();
    await admission;
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].intent, becomesActive ? "steer" : "continue");
  }
});

test("pending turns and every exact-owner drift reject before enqueue or dispatch", async () => {
  const mutations: Array<(f: ReturnType<typeof setup>) => void> = [
    f => { f.lifecycle.projectContextGeneration++; },
    f => { f.lifecycle.projectId = ProjectIdSchema.parse("other"); },
    f => { f.lifecycle.projectRootPath = "C:/other"; },
    f => { f.lifecycle.messageAdmissionIntentRevision++; },
    f => { f.documents.selectDocumentKey(""); },
    f => { f.lifecycle.disposed = true; },
    f => { f.sources.update("codex:thread", source => ({
      ...source, turns: [withWorkbenchTurnAdmission(source.turns[0]!, "providerPending")],
    })); },
  ];
  for (const mutate of mutations) {
    const connection = deferred<void>();
    const f = setup({ connect: () => connection.promise });
    const admission = f.admit();
    mutate(f);
    connection.resolve();
    await assert.rejects(admission, ThreadMessageNotSentError);
    assert.equal(f.messages.length, 0);
    assert.equal(f.events.includes("pending"), false);
  }
});

test("failed admission settles one optimistic projection unless canonical delivery already won", async () => {
  for (const delivered of [false, true]) {
    const f = setup({
      deliveredAfterFailure: delivered,
      submit: async () => { throw new Error("late failure"); },
    });
    f.idle();
    if (delivered) assert.equal((await f.admit()).kind, "admitted");
    else await assert.rejects(f.admit(), /late failure/);
    assert.deepEqual(f.events, ["connect", "pending", "failed"]);
  }
});

test("canonical steer delivery wins a delayed failure or differing acknowledgement", async () => {
  for (const fail of [false, true]) {
    let f: ReturnType<typeof setup>;
    f = setup({ submit: async message => {
      f.optimisticInputs.confirmCanonicalUserMessage("codex:thread", "canonical-turn", {
        clientId: message.clientMessageId, content: input, id: "canonical", type: "userMessage",
      });
      if (fail) throw new Error("late failure");
      return { kind: "steered", turnId: "other-turn" };
    } });
    assert.equal((await f.admit()).kind, "admitted");
  }
});

test("interruption before acknowledgement is not delivery", async () => {
  let f: ReturnType<typeof setup>;
  f = setup({ submit: async message => {
    f.optimisticInputs.transition(message.clientMessageId, "interrupted");
    return { kind: "steered", turnId: "other-turn" };
  } });
  await assert.rejects(f.admit(), /stopped before this steer was delivered/);
});

test("pending mismatched acknowledgements request reconciliation and rendering failures only warn", async () => {
  const f = setup({ submit: async () => ({ kind: "steered", turnId: "other-turn" }) });
  assert.equal((await f.admit()).kind, "admittedNeedsReconciliation");
  assert.ok(f.events.some(event => event.startsWith("warning:")));
  const brokenRendering = setup({ renderFailure: true });
  assert.equal((await brokenRendering.admit()).kind, "admitted");
  assert.equal(brokenRendering.events.filter(event => event.startsWith("warning:")).length, 1);
});

test("overlapping acknowledgements settle in reverse order without losing optimistic entries", async () => {
  const responses = [deferred<WorkbenchThreadMessageResult>(), deferred<WorkbenchThreadMessageResult>()];
  const entered = deferred<void>();
  let calls = 0;
  const f = setup({ submit: message => {
    const response = responses[calls++];
    if (calls === 2) entered.resolve();
    assert.ok(message.clientMessageId);
    return response.promise;
  } });
  const first = f.admit();
  const second = f.admit();
  await entered.promise;
  responses[1].resolve({ kind: "steered", turnId: "turn" });
  responses[0].resolve({ kind: "steered", turnId: "turn" });
  await Promise.all([first, second]);
  assert.equal(f.optimisticInputs.apply(thread(), []).turns[0]?.items.length, 2);
});

test("rejected steer marks the exact pending entry failed", async () => {
  const f = setup({ submit: async () => { throw new Error("rejected"); } });
  await assert.rejects(f.admit(), /rejected/);
  const item = f.optimisticInputs.apply(thread(), []).turns[0]?.items[0];
  assert.ok(item);
  assert.equal(getWorkbenchInputState(item)?.status, "failed");
});
