/*
 * No production exports. Tests protect OpenCode admission, accepted questionnaire history and canonical message pagination.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import OpenCodeThreadOperations from "./OpenCodeThreadOperations";
import type { WorkbenchToolTranscriptReference, ProviderToolResult } from "workbench-shared/workbench/provider/provider-execution";
import WorkbenchTurnRecoveryController from "../../WorkbenchTurnRecoveryController";
import type { WorkbenchQuestionnaireHistoryEntryState, WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import { isWorkbenchUnfinishedTurnInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import type OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import { createThreadStateTestDatabase } from "../../workbench-thread-state-test-database";
import WorkbenchTranscriptRepository from "../../database/transcript/WorkbenchTranscriptRepository";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { normalizeProviderSidebarEntry } from "../../WorkbenchThreadStateFeature";

test("accepted questionnaires persist once in their accepted turn and recording failures propagate", async () => {
  const fixture = createThreadStateTestDatabase();
  fixture.admitThread(testProjectIds.project, threadId, "opencode", nativeThreadId, "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    transcript: { record: async observations => repository.settle(observations) },
  });
  try {
    const project = { id: testProjectIds.project, rootPath: "C:/repo" };
    const first = { id: "first", type: "user" as const, text: "work", time: { created: 1 } };
    const admitted = await adapter.record(session, [first], project);
    assert.ok(admitted.latestTurnId);
    const entry: WorkbenchQuestionnaireHistoryEntryState = {
      threadId: admitted.threadId, turnId: admitted.latestTurnId,
      itemId: "accepted-question", requestKey: "workbench-mcp:question",
      insertAfterItemId: null, insertAfterItemIndex: null, resolvedAt: 3,
      request: {
        id: "request", title: "direction", summary: "", submitLabel: "submit",
        questions: [{ id: "direction", header: "direction", question: "which route?",
          options: [{ label: "continue", description: "keep working" }], allowOther: true, isSecret: false }],
      },
      response: { answers: { direction: { answers: ["continue", "with this detail"] } } },
    };
    const newer = await adapter.record(session, [first,
      { id: "newer", type: "user", text: "next", time: { created: 4 } }], project);
    assert.notEqual(newer.latestTurnId, entry.turnId);
    const owner = operations({}, adapter);
    await owner.interactions.record(entry);
    await owner.interactions.record(entry);
    const reopened = projectWorkbenchTranscript(new WorkbenchTranscriptRepository(fixture.sqlite).read({
      threadId: admitted.threadId, turnLimit: 2,
    })!);
    assert.ok(reopened.success);
    const questions = reopened.data.turns.flatMap(turn => turn.items.flatMap(item =>
      item.type === "questionnaire" ? [{ turnId: turn.id, item }] : []));
    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.turnId, entry.turnId);
    assert.deepEqual(questions[0]?.item.request, entry.request);
    assert.deepEqual(questions[0]?.item.response, entry.response);
    assert.equal(questions[0]?.item.resolvedAt, entry.resolvedAt);

    const unavailable = new Error("transcript recording unavailable");
    const failing = operations({}, new OpenCodeTranscriptAdapter({
      ...fixture.identities,
      transcript: { record: async () => { throw unavailable; } },
    }));
    await assert.rejects(failing.interactions.record(entry), error => error === unavailable);
  } finally {
    fixture.sqlite.close();
  }
});

test("late child completion stays in its starting turn after a newer turn is admitted", async () => {
  let latest = turnId;
  let finished: WorkbenchToolTranscriptReference | null = null;
  const owner = operations({ message: { list: async () => ({ data: [], cursor: {} }) } }, {
    record: async () => ({ threadId, latestTurnId: latest }),
    startToolTranscript: async (input: Omit<WorkbenchToolTranscriptReference, "itemId">) => ({ ...input, itemId: "item" }),
    finishToolTranscript: async (reference: WorkbenchToolTranscriptReference, _result: ProviderToolResult) => { finished = reference; },
  });
  const reference = await owner.startToolTranscript({
    tool: "rg", arguments: {}, metadata: { sessionID: nativeThreadId },
  }, { childID: "0c706b28-4f7b-4510-a814-331d729e3f6a", parentID: "execute", assistantMessageID: "assistant" },
  { harness: "opencode", threadId, cwd: "C:/repo" });
  latest = WorkbenchTurnIdSchema.parse("newer");
  await owner.syncNative(nativeThreadId);
  assert.equal(owner.currentTurn(nativeThreadId)?.turnId, latest);
  await owner.finishToolTranscript(reference, { content: [{ type: "text", text: "late" }] });
  assert.equal(finished, reference);
  assert.equal(reference.turnId, turnId);
});

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const nativeThreadId = NativeThreadIdSchema.parse("native-session");
const session = {
  id: nativeThreadId,
  projectID: "native-project",
  title: "Thread",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "C:/repo" },
};

function operations(
  client: object,
  transcript: object,
  state: object = {},
  lifecycle: {
    observe?: (facts: object) => Promise<void>;
    questionnaires?: object;
    readPage?: () => Promise<object>;
    resolveTurn?: (input: { threadId: string; turnId: string }) => Promise<{ threadId: typeof threadId; turnId: typeof turnId } | null>;
    signal?: AbortSignal;
    refresh?: OpenCodeManagedSessionController["refresh"];
  } = {},
) {
  const owner: OpenCodeThreadOperations = new OpenCodeThreadOperations({
    reconciliation: { reconcile: (input, signal) => owner.reconcile({ ...input, gapIds: [] }, signal ?? new AbortController().signal) },
    readProviderCursor: async () => undefined,
    acquire: async () => {
      const value = client as { session?: Record<string, unknown> };
      return {
        ...value,
        session: {
          get: async () => session,
          inbox: { list: async () => [] },
          ...value.session,
        },
      } as never;
    },
    observe: lifecycle.observe ?? (async () => undefined),
    identities: {
      findNativeThread: () => null,
      resolve: async () => ({
        threadId,
        projectId: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
        projectRoot: "C:/repo",
        bindings: [{
          harness: "opencode",
          nativeLocation: "C:/repo",
          nativeThreadId,
          pending: false,
          turnIndex: 0,
        }],
      }),
      resolveTurn: lifecycle.resolveTurn ?? (async ({ turnId: requestedTurnId }) => ({
        threadId,
        turnId: WorkbenchTurnIdSchema.parse(requestedTurnId),
      })),
    } as never,
    projects: {
      resolveProjectById: async () => ({
        id: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
        rootPath: "C:/repo",
      }),
      resolveAgentEndpointProjectFromCwd: async () => ({
        project: {
          id: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
          rootPath: "C:/repo",
        },
      }),
    } as never,
    state: {
      controller: { getCanonicalThreadEntry: async () => null },
      installCreatedProfile: async () => undefined,
      ...state,
    } as never,
    managed: {
      creation: () => ({
        metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
        permissions: [],
      }),
      refresh: lifecycle.refresh ?? (async () => undefined),
    },
    questionnaires: lifecycle.questionnaires as never ?? {
      canDeliver: () => false,
      deliver: async () => null,
      interruptRetainingQuestionnaire: async (
        _threadId: string,
        _requestKey: string,
        interrupt: () => Promise<boolean>,
      ) => interrupt(),
    } as never,
    transcript: transcript as never,
    reader: {
      readPage: lifecycle.readPage ?? (async () => ({
        thread: { turns: [{ id: turnId, status: "inProgress", items: [] }] },
      })),
    } as never,
    signal: lifecycle.signal ?? new AbortController().signal,
    recovery: new WorkbenchTurnRecoveryController(() => undefined),
  });
  return owner;
}

test("cold opencode reads hydrate active canonical turns before sidebar projection", async () => {
  let hydrated = false;
  const thread = {
    id: threadId, cwd: "C:/repo", name: "Thread", status: "active", updatedAt: 2,
    turns: [{ id: turnId, status: "inProgress", items: [] }],
  };
  const owner = operations({
    session: { list: async () => ({ data: [session], cursor: {} }) },
  }, {
    record: async () => ({ threadId, latestTurnId: null }),
  }, {}, {
    readPage: async () => ({ thread }),
    resolveTurn: async ({ threadId: requestedThreadId, turnId: requestedTurnId }) => {
      assert.equal(requestedThreadId, threadId);
      assert.equal(requestedTurnId, turnId);
      hydrated = true;
      return { threadId, turnId };
    },
  });
  const project = (value: object) => normalizeProviderSidebarEntry("opencode", value, {
    knownThread: () => ({ threadId }),
    knownTurn: () => {
      if (!hydrated) throw new Error("Canonical turn identity has not been hydrated.");
      return { turnId };
    },
  });

  const readEntry = project(await owner.read(threadId));
  assert.ok(readEntry?.entryKind === "thread");
  assert.equal(readEntry.lifecycle.kind, "working");
  hydrated = false;
  const listed = await owner.list({ cwd: "C:/repo", cursor: null, limit: 50, archived: false, background: true });
  assert.equal(listed.data.length, 1);
  const listedEntry = project(listed.data[0]!);
  assert.ok(listedEntry?.entryKind === "thread");
  assert.equal(listedEntry.lifecycle.kind, "working");

  const missing = operations({}, {
    record: async () => ({ threadId, latestTurnId: null }),
  }, {}, {
    readPage: async () => ({ thread }),
    resolveTurn: async () => null,
  });
  await assert.rejects(missing.read(threadId), /canonical active turn does not belong/u);
});

test("admits a created session into thread state with its captured profile", async () => {
  const profile = {
    kind: "profile" as const,
    profileId: "profile",
    settings: {
      agentPath: null,
      agentSource: null,
      harness: "opencode" as const,
      model: "opencode/muse-spark-1.3-contributor-free",
      reasoningEffort: null,
      serviceTier: null,
    },
  };
  const thread = {
    id: threadId,
    cwd: "C:/repo",
    harness: "opencode" as const,
    name: "Thread",
    preview: "",
    status: { type: "idle" as const },
    turns: [],
    updatedAt: 2,
  };
  const installed: object[] = [];
  const admittedOwners: object[] = [];
  const owner = operations({
    session: { create: async () => session },
  }, {
    record: async (_session: object, _messages: object[], project: object) => {
      admittedOwners.push(project);
      return { threadId, latestTurnId: null };
    },
  }, {
    installCreatedProfile: async (...input: object[]) => { installed.push(input); },
  });
  Object.assign(owner, {
    read: async () => thread,
  });

  assert.equal(await owner.create({
    cwd: "C:/repo",
    profile,
    projectRoots: ["C:/repo"],
    projectLocation: { id: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
      rootPath: "C:/repo", launchId: "84f3661a-1ba2-4191-8118-851255a5f1de" },
  }), thread);
  assert.deepEqual(admittedOwners, [{
    id: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
    rootPath: "C:/repo", launchId: "84f3661a-1ba2-4191-8118-851255a5f1de",
  }]);
  assert.deepEqual(installed, [["opencode", thread, profile]]);
});

test("an early created event waits for captured session ownership before history admission", async () => {
  let release!: (value: typeof session) => void;
  const creating = new Promise<typeof session>(resolve => { release = resolve; });
  let syncEntered!: () => void;
  const entered = new Promise<void>(resolve => { syncEntered = resolve; });
  let finishSync!: () => void;
  const syncing = new Promise<void>(resolve => { finishSync = resolve; });
  let records = 0;
  const owner = operations({
    session: { create: async () => await creating },
  }, {
    record: async () => { records += 1; return { threadId, latestTurnId: null }; },
  });
  let synced = 0;
  Object.assign(owner, {
    read: async () => ({ id: threadId, cwd: "C:/repo" }),
    syncNative: async () => {
      assert.ok(records >= 1);
      synced += 1;
      syncEntered();
      await syncing;
      return { threadId };
    },
  });
  const launch = owner.create({
    cwd: "C:/repo",
    profile: {
      kind: "custom",
      settings: { agentPath: null, agentSource: null, harness: "opencode", model: "",
        reasoningEffort: null, serviceTier: null },
    },
  });
  assert.equal(await owner.syncCreatedNative(nativeThreadId), null);
  assert.equal(records, 0);
  release(session);
  try {
    await entered;
    assert.equal(owner.hasPendingWork(), true, "deferred admission is still part of creation lifecycle");
  } finally { finishSync(); }
  await launch;
  assert.ok(records >= 1);
  assert.equal(synced, 1);
});

test("fails a public read when no OpenCode binding exists", async () => {
  const owner = new OpenCodeThreadOperations({
    recovery: new WorkbenchTurnRecoveryController(() => undefined),
    reconciliation: { reconcile: async () => { throw new Error("Unexpected recovery"); } },
    readProviderCursor: async () => undefined,
    acquire: async () => ({}) as never,
    observe: async () => undefined,
    identities: { resolve: async () => null } as never,
    projects: {} as never,
    state: {} as never,
    managed: {
      creation: () => ({
        metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
        permissions: [],
      }),
      refresh: async () => undefined,
    },
    questionnaires: {
      canDeliver: () => false,
      deliver: async () => null,
      interruptRetainingQuestionnaire: async (
        _threadId: string,
        _requestKey: string,
        interrupt: () => Promise<boolean>,
      ) => interrupt(),
    } as never,
    transcript: {} as never,
    reader: {} as never,
    signal: new AbortController().signal,
  });
  await assert.rejects(owner.read("missing"), /identity is unavailable/u);
});

test("opening a 200-page session records only the latest complete turn", async () => {
  const requests: object[] = [];
  let recorded: string[] = [];
  const owner = operations({
    session: { get: async () => session },
    message: {
      list: async (input: { cursor?: string }) => {
        requests.push(input);
        const page = Number(input.cursor ?? 0);
        return {
          data: [
            { id: `assistant-${page}`, type: "assistant", agent: "agent", model: { id: "m", providerID: "p" }, content: [], time: { created: 2, completed: 3 } },
            { id: `user-${page}`, type: "user", text: "hello", time: { created: 1 } },
          ],
          cursor: page < 199 ? { next: String(page + 1) } : {},
        };
      },
    },
  }, {
    record: async (_session: object, messages: Array<{ id: string }>) => {
      recorded = messages.map(message => message.id);
      return { threadId, latestTurnId: turnId };
    },
  });

  await owner.syncNative(nativeThreadId);
  assert.equal(requests.length, 1);
  assert.deepEqual(recorded, ["user-0", "assistant-0"]);
});

test("provider-owned active execution submits a steer once with native steer delivery", async () => {
  const prompts: object[] = [];
  const steerObservations: Array<{ clientUserMessageId: string | null; status: string }> = [];
  const owner = operations({
    session: {
      prompt: async (input: object) => {
        prompts.push(input);
        return {
          id: "inbox",
          sessionID: nativeThreadId,
          time: { created: 3 },
          type: "user",
          payload: { text: "please continue" },
          delivery: "steer",
        };
      },
    },
  }, {
    recordSteer: async (entry: { clientUserMessageId: string | null; status: string }) => { steerObservations.push(entry); },
  });

  const result = await owner.submit({
    threadId,
    clientMessageId: "00000000-0000-4000-8000-000000000010",
    input: [{ type: "text", text: "please continue", text_elements: [] }],
    intent: "continue",
  });

  const submitted = prompts[0] as {
    id: string;
    metadata: { workbench: {
      clientMessageId: string;
      delivery: string;
      input: object[];
      itemId: string;
      version: number;
    } };
  };
  assert.deepEqual({
    ...submitted,
    metadata: {
      workbench: {
        ...submitted.metadata.workbench,
        itemId: "<uuid>",
      },
    },
  }, {
    sessionID: nativeThreadId,
    id: "msg_00000000-0000-4000-8000-000000000010",
    text: "please continue",
    delivery: "steer",
    metadata: {
      workbench: {
        version: 1,
        delivery: "steer",
        itemId: "<uuid>",
        clientMessageId: "00000000-0000-4000-8000-000000000010",
        input: [{ type: "text", text: "please continue", text_elements: [] }],
      },
    },
  });
  assert.match(submitted.metadata.workbench.itemId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(result, { kind: "steered", turnId });
  assert.equal(steerObservations.length, 1);
  assert.deepEqual(steerObservations.map(entry => ({
    clientUserMessageId: entry.clientUserMessageId,
    status: entry.status,
  })), [{
    clientUserMessageId: "00000000-0000-4000-8000-000000000010",
    status: "pending",
  }]);
});

const unfinished: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };

test("execution outlives submission and only terminal execution releases the idle boundary", async () => {
  const pending = Promise.withResolvers<object>();
  const owner = operations({
    session: { prompt: async () => pending.promise },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "inProgress" }) });
  await owner.submit({ threadId, clientMessageId: "idle-boundary", intent: "newTurn",
    input: [{ type: "text", text: "work", text_elements: [] }] });
  assert.equal(owner.hasPendingWork(), true);
  pending.resolve({});
  await owner.settle();
  assert.equal(owner.hasPendingWork(), true);
  owner.markExecutionSettled(nativeThreadId);
  assert.equal(owner.hasPendingWork(), false);
});

test("unfinished completion admits the hidden continuation once, while terminal task decisions and interruption do not", async () => {
  for (const state of [
    unfinished,
    { kind: "completed", reason: "agentCompleted", settled: false, agent: { agentStatus: "completed", turnId } },
    { kind: "needsAttention", reason: "agentBlocked", settled: false, agent: { agentStatus: "blocked", turnId } },
    { kind: "needsAttention", reason: "pendingInput", settled: false, requestKey: "question" },
  ] as WorkbenchThreadLifecycle[]) {
    const prompts: { text: string; metadata: { workbench: { input: Parameters<typeof isWorkbenchUnfinishedTurnInput>[0] } } }[] = [];
    const owner = operations({
      session: { prompt: async input => { prompts.push(input); return {}; } },
      message: { list: async () => ({ data: [], cursor: {} }) },
    }, {
      record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "completed" }),
    }, { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread", lifecycle: state }) } });
    await owner.syncNative(nativeThreadId);
    const completion = { sessionID: nativeThreadId, eventID: "end", turnId, status: "completed" as const, lifecycle: state };
    assert.equal(owner.acceptExecutionEvent(nativeThreadId, 10), true);
    await owner.completeExecution(completion);
    assert.equal(owner.acceptExecutionEvent(nativeThreadId, 10), false);
    assert.equal(owner.acceptExecutionEvent(nativeThreadId, 9), false);
    await owner.completeExecution({ ...completion, status: "interrupted" });
    await owner.completeExecution({ ...completion, status: "failed" });
    assert.equal(prompts.length, state === unfinished ? 1 : 0);
    if (prompts.length) assert.equal(isWorkbenchUnfinishedTurnInput(prompts[0]!.metadata.workbench.input), true);
    await owner.settle();
  }
});

test("a fresh task decision suppresses a continuation requested against stale unfinished state", async () => {
  let prompts = 0;
  const owner = operations({
    session: { prompt: async () => { prompts++; return {}; } },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "completed" }) },
  { controller: { getCanonicalThreadEntry: async () => ({
    entryKind: "thread", lifecycle: { kind: "needsAttention", reason: "agentBlocked", settled: false, agent: { agentStatus: "blocked", turnId } },
  }) } });
  await owner.syncNative(nativeThreadId);
  await owner.completeExecution({ sessionID: nativeThreadId, eventID: "end", turnId, status: "completed", lifecycle: unfinished });
  assert.equal(prompts, 0);
});

test("a task blocked during continuation preparation is not submitted", async () => {
  let reads = 0;
  let prompts = 0;
  const owner = operations({
    session: { prompt: async () => { prompts++; return {}; } },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "completed" }) },
  { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread",
    lifecycle: ++reads === 1 ? unfinished : {
      kind: "needsAttention", reason: "agentBlocked", settled: false, agent: { agentStatus: "blocked", turnId },
    },
  }) } });
  await owner.syncNative(nativeThreadId);
  await owner.completeExecution({ sessionID: nativeThreadId, eventID: "end", turnId, status: "completed", lifecycle: unfinished });
  assert.equal(prompts, 0);
});

test("continuation disposal and failed admission do not retry or lose failure state", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const signal = new AbortController();
  const observations: object[] = [];
  let records = 0;
  const owner = operations({ message: { list: async () => ({ data: [], cursor: {} }) } }, {
    record: async () => {
      if (++records > 2) throw new Error("PRIVATE admission error");
      return { threadId, latestTurnId: turnId, latestTurnState: "completed" };
    },
  }, { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread", lifecycle: unfinished }) } },
  { signal: signal.signal, observe: async facts => { observations.push(facts); } });
  await owner.syncNative(nativeThreadId);
  const completion = { sessionID: nativeThreadId, eventID: "end", turnId, status: "completed" as const, lifecycle: unfinished };
  await owner.completeExecution(completion);
  assert.equal(records, 3);
  assert.deepEqual(observations, [{ activity: null, displayLabel: null, lifecycle: { threadId, event: { kind: "recoveryFailed" } } }]);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings.join(""), /PRIVATE/);
  signal.abort();
  await owner.completeExecution(completion);
  assert.equal(records, 3);
});

test("new user intent admitted before completion enforcement wins over the stale continuation", async () => {
  const prompts: string[] = [];
  const nextTurn = WorkbenchTurnIdSchema.parse("next-turn");
  let recorded = turnId;
  const owner = operations({
    session: { prompt: async (input: { text: string }) => { prompts.push(input.text); return {}; } },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: recorded, latestTurnState: "completed" }) },
  { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread", lifecycle: unfinished }) } });
  await owner.syncNative(nativeThreadId);
  const version = owner.executionIntentVersion(nativeThreadId);
  recorded = nextTurn;
  await owner.submit({ threadId, clientMessageId: "user", intent: "newTurn",
    input: [{ type: "text", text: "new direction", text_elements: [] }] });
  await owner.completeExecution({ sessionID: nativeThreadId, eventID: "end", turnId, status: "completed",
    lifecycle: unfinished, intentVersion: version });
  assert.deepEqual(prompts, ["new direction"]);
  await owner.settle();
});

test("hidden continuation retains workflow and activated skill instructions", async () => {
  const refreshes: Parameters<OpenCodeManagedSessionController["refresh"]>[0][] = [];
  const owner = operations({
    session: { prompt: async () => ({}) },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "completed" }) },
  { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread", lifecycle: unfinished }) } },
  { refresh: async input => { refreshes.push(input); } });
  await owner.submit({ threadId, clientMessageId: "user", intent: "newTurn",
    input: [{ type: "skill", name: "review", path: "skills/review" }],
    context: { workflowIds: ["default"], activatedSkillPaths: ["skills/react"] } });
  owner.markExecutionSettled(nativeThreadId);
  await owner.completeExecution({ sessionID: nativeThreadId, eventID: "end", turnId,
    status: "completed", lifecycle: unfinished });
  assert.equal(refreshes.length, 2);
  assert.deepEqual(refreshes[1]!.workflowIds, ["default"]);
  assert.deepEqual(new Set(refreshes[1]!.activatedSkillPaths), new Set(["skills/react", "skills/review"]));
  await owner.settle();
});

test("user intent arriving during continuation preparation cancels only the hidden prompt", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: string[] = [];
  let prepare = false;
  const owner = operations({
    session: { prompt: async (input: { text: string }) => { prompts.push(input.text); return {}; } },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, { record: async () => ({ threadId, latestTurnId: turnId, latestTurnState: "completed" }) },
  { controller: { getCanonicalThreadEntry: async () => ({ entryKind: "thread", lifecycle: unfinished }) } },
  { refresh: async () => { if (prepare) { entered.resolve(); await release.promise; } } });
  await owner.submit({ threadId, clientMessageId: "first", intent: "newTurn",
    input: [{ type: "text", text: "first", text_elements: [] }], context: { workflowIds: ["default"] } });
  owner.markExecutionSettled(nativeThreadId);
  prepare = true;
  const continuation = owner.completeExecution({ sessionID: nativeThreadId, eventID: "end", turnId,
    status: "completed", lifecycle: unfinished });
  await entered.promise;
  const submission = owner.submit({ threadId, clientMessageId: "next", intent: "newTurn",
    input: [{ type: "text", text: "new direction", text_elements: [] }] });
  prepare = false;
  release.resolve();
  await Promise.all([continuation, submission]);
  assert.deepEqual(prompts, ["first", "new direction"]);
  await owner.settle();
});

test("late history synchronisation cannot replace a newly admitted turn", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nextTurn = WorkbenchTurnIdSchema.parse("new-turn");
  let delayHistory = false;
  const owner = operations({
    session: { prompt: async () => ({}) },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }, {
    record: async (_session: object, messages: object[]) => {
      if (messages.length) return { threadId, latestTurnId: nextTurn, latestTurnState: "inProgress" };
      if (delayHistory) { reading.resolve(); await release.promise; }
      return { threadId, latestTurnId: turnId, latestTurnState: "completed" };
    },
  });
  await owner.syncNative(nativeThreadId);
  delayHistory = true;
  const history = owner.syncNative(nativeThreadId);
  await reading.promise;
  await owner.submit({ threadId, clientMessageId: "new", intent: "newTurn",
    input: [{ type: "text", text: "new direction", text_elements: [] }] });
  release.resolve();
  await history;
  assert.equal(owner.currentTurn(nativeThreadId)?.turnId, nextTurn);
  await owner.settle();
});

test("a late rejected prompt cannot make a newer active turn idle", async () => {
  const first = Promise.withResolvers<never>();
  const deliveries: string[] = [];
  let roots = 0;
  const owner = operations({
    session: { prompt: async (input: { delivery: string }) => {
      deliveries.push(input.delivery);
      if (deliveries.length === 1) return first.promise;
      return {};
    } },
  }, {
    record: async () => ({ threadId, latestTurnId: WorkbenchTurnIdSchema.parse(`root-${++roots}`) }),
    recordSteer: async () => undefined,
  });
  for (const id of ["first", "second"]) await owner.submit({
    threadId, clientMessageId: id, intent: "newTurn",
    input: [{ type: "text", text: id, text_elements: [] }],
  });
  first.reject(new Error("old prompt rejected"));
  await owner.settle();
  await owner.submit({ threadId, clientMessageId: "steer", intent: "continue",
    input: [{ type: "text", text: "new direction", text_elements: [] }] });
  assert.deepEqual(deliveries, ["queue", "queue", "steer"]);
  await owner.settle();
});

test("admits a root turn directly without rereading provider history", async () => {
  const previousTurnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000020");
  const recorded: Array<{ session: object; messages: object[] }> = [];
  let owner!: OpenCodeThreadOperations;
  let ownerAtPrompt: object | null = null;
  owner = operations({
    session: {
      get: async () => session,
      prompt: async () => {
        ownerAtPrompt = owner.currentTurn(nativeThreadId);
        return {
          id: "inbox",
          sessionID: nativeThreadId,
          time: { created: 3 },
          type: "user",
          payload: { text: "hello" },
          delivery: "queue",
        };
      },
    },
  }, {
    record: async (nativeSession: object, messages: object[]) => {
      recorded.push({ session: nativeSession, messages });
      return { threadId, latestTurnId: turnId };
    },
  }, {}, {
    readPage: async () => ({
      thread: { turns: [{ id: previousTurnId, status: "completed", items: [] }] },
    }),
  });
  Object.assign(owner, {
    read: async () => ({ turns: [{ id: turnId, status: "inProgress", items: [] }] }),
  });

  const result = await owner.submit({
    threadId,
    clientMessageId: "client-message",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "newTurn",
    context: { workflowIds: [] },
  });

  assert.equal(recorded.length, 1);
  assert.deepEqual(ownerAtPrompt, { threadId, turnId });
  assert.equal(recorded[0]!.session, session);
  const recordedMessage = recorded[0]!.messages[0] as {
    id: string; text: string; time: { created: unknown }; type: string;
  };
  assert.deepEqual({
    id: recordedMessage.id,
    text: recordedMessage.text,
    type: recordedMessage.type,
  }, { id: "msg_client-message", text: "hello", type: "user" });
  assert.equal(typeof recordedMessage.time.created, "number");
  assert.deepEqual(result, {
    kind: "started",
    turn: { id: turnId, status: "inProgress", items: [] },
  });
});

test("provider-owned idle execution starts an ordinary continuation", async () => {
  const prompts: Array<{ delivery: string }> = [];
  const owner = operations({
    session: {
      get: async () => ({ ...session, outcome: "succeeded" }),
      prompt: async (input: { delivery: string }) => {
        prompts.push(input);
        return { id: "inbox", sessionID: nativeThreadId, time: { created: 3 }, type: "user" };
      },
    },
  }, {
    record: async () => ({ threadId, latestTurnId: turnId }),
  });
  Object.assign(owner, {
    read: async () => ({ turns: [{ id: turnId, status: "inProgress", items: [] }] }),
  });

  const result = await owner.submit({
    threadId,
    clientMessageId: "client-message",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "continue",
  });

  assert.equal(prompts[0]?.delivery, "queue");
  assert.equal(result.kind, "started");
});

test("provider reload treats a surviving managed inbox prompt as active execution ownership", async () => {
  const prompts: Array<{ delivery: string }> = [];
  const steerObservations: object[] = [];
  const owner = operations({
    session: {
      get: async () => ({ ...session, outcome: "failed" }),
      inbox: {
        list: async () => [{
          id: "pending-inbox",
          sessionID: nativeThreadId,
          time: { created: 2 },
          type: "user",
          payload: {
            text: "earlier work",
            metadata: { workbench: { version: 1 } },
          },
          delivery: "queue",
        }],
      },
      prompt: async (input: { delivery: string }) => {
        prompts.push(input);
        return {
          id: "steer-inbox",
          sessionID: nativeThreadId,
          time: { created: 3 },
          type: "user",
          payload: { text: "please continue" },
          delivery: "steer",
        };
      },
    },
  }, {
    record: async () => ({ threadId, latestTurnId: turnId }),
    recordSteer: async (entry: object) => { steerObservations.push(entry); },
  }, {}, {
    readPage: async () => ({
      thread: { turns: [{ id: turnId, status: "failed", items: [] }] },
    }),
  });

  const result = await owner.submit({
    threadId,
    clientMessageId: "00000000-0000-4000-8000-000000000010",
    input: [{ type: "text", text: "please continue", text_elements: [] }],
    intent: "continue",
  });

  assert.equal(prompts[0]?.delivery, "steer");
  assert.deepEqual(result, { kind: "steered", turnId });
  assert.equal(steerObservations.length, 1);
});

test("preserves a root when an ambiguous prompt failure still exists in the native inbox", async () => {
  let inboxReads = 0;
  let promptCalls = 0;
  const lifecycle: object[] = [];
  const owner = operations({
    session: {
      get: async () => ({ ...session, outcome: "failed" }),
      inbox: {
        list: async () => ++inboxReads === 1 ? [] : [{
          id: "msg_client-message",
          sessionID: nativeThreadId,
          time: { created: 3 },
          type: "user",
          payload: {
            text: "hello",
            metadata: { workbench: { version: 1 } },
          },
          delivery: "queue",
        }],
      },
      prompt: async () => {
        if (++promptCalls === 1) throw new Error("connection closed after admission");
        return { id: "steer", sessionID: nativeThreadId, time: { created: 4 }, type: "user" };
      },
    },
  }, {
    record: async () => ({ threadId, latestTurnId: turnId }),
    recordSteer: async () => undefined,
  }, {}, {
    observe: async facts => { lifecycle.push(facts); },
    readPage: async () => ({
      thread: { turns: [{ id: turnId, status: "completed", items: [] }] },
    }),
  });
  Object.assign(owner, {
    read: async () => ({ turns: [{ id: turnId, status: "inProgress", items: [] }] }),
  });

  assert.equal((await owner.submit({
    threadId,
    clientMessageId: "client-message",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "newTurn",
  })).kind, "started");
  await owner.settle();
  const continuation = await owner.submit({
    threadId,
    clientMessageId: "00000000-0000-4000-8000-000000000010",
    input: [{ type: "text", text: "continue", text_elements: [] }],
    intent: "continue",
  });

  assert.deepEqual(lifecycle, []);
  assert.deepEqual(continuation, { kind: "steered", turnId });
});

test("fails and releases a root when rejected prompt admission is absent from the native inbox", async () => {
  let promptCalls = 0;
  const deliveries: string[] = [];
  const lifecycle: object[] = [];
  const owner = operations({
    session: {
      get: async () => ({ ...session, outcome: "failed" }),
      inbox: { list: async () => [] },
      prompt: async (input: { delivery: string }) => {
        deliveries.push(input.delivery);
        if (++promptCalls === 1) throw new Error("admission rejected");
        return { id: "root", sessionID: nativeThreadId, time: { created: 4 }, type: "user" };
      },
    },
  }, {
    record: async () => ({ threadId, latestTurnId: turnId }),
    recordSteer: async () => undefined,
  }, {}, {
    observe: async facts => { lifecycle.push(facts); },
    readPage: async () => ({
      thread: { turns: [{ id: turnId, status: "completed", items: [] }] },
    }),
  });
  Object.assign(owner, {
    read: async () => ({ turns: [{ id: turnId, status: "inProgress", items: [] }] }),
  });

  await owner.submit({
    threadId,
    clientMessageId: "client-message",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "newTurn",
  });
  await owner.settle();
  const continuation = await owner.submit({
    threadId,
    clientMessageId: "next-message",
    input: [{ type: "text", text: "retry", text_elements: [] }],
    intent: "continue",
  });

  assert.equal(lifecycle.length, 1);
  assert.deepEqual(deliveries, ["queue", "queue"]);
  assert.equal(continuation.kind, "started");
});

test("fails an admitted steer without failing its active turn when OpenCode rejects it", async () => {
  const steerObservations: Array<{ status: string }> = [];
  const owner = operations({
    session: {
      prompt: async () => {
        throw {
          _tag: "InvalidRequestError",
          field: "model",
          kind: "validation",
          message: "The selected model is unavailable.",
        };
      },
    },
  }, {
    recordSteer: async (entry: { status: string }) => { steerObservations.push(entry); },
  });

  await assert.rejects(owner.submit({
    threadId,
    clientMessageId: "00000000-0000-4000-8000-000000000010",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "continue",
  }), /selected model is unavailable/u);
  assert.deepEqual(steerObservations.map(entry => entry.status), ["pending", "failed"]);
});

test("owns provider rejection when root transcript admission fails", async () => {
  const owner = operations({
    session: {
      get: async () => session,
      prompt: async () => {
        throw new Error("provider rejected");
      },
    },
  }, {
    record: async () => {
      await Promise.resolve();
      throw new Error("transcript admission failed");
    },
  });

  await assert.rejects(owner.submit({
    threadId,
    clientMessageId: "client-message",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    intent: "newTurn",
    context: { workflowIds: [] },
  }), /transcript admission failed/u);
  await owner.settle();
});

test("delivers a live Workbench questionnaire through the canonical waiter", async () => {
  const delivered: object[] = [];
  const owner = operations({}, {}, {}, {
    questionnaires: {
      canDeliver: (candidateThreadId: string, requestKey: string) =>
        candidateThreadId === threadId && requestKey === "request",
      deliver: async (input: object) => {
        delivered.push(input);
        return { requestKey: "request" };
      },
      interruptRetainingQuestionnaire: async () => false,
    },
  });
  const response = { answers: { scenario: { answers: ["continue"] } } };

  assert.equal(await owner.interactions.canDeliver(threadId, "request"), true);
  assert.equal(await owner.interactions.deliver({ threadId, requestKey: "request", response }), true);
  assert.deepEqual(delivered, [{ threadId, requestKey: "request", response }]);
});

test("retains a questionnaire while interrupting its exact OpenCode session", async () => {
  const calls: string[] = [];
  const owner = operations({
    session: {
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`interrupt:${sessionID}`);
      },
      get: async () => session,
    },
    message: {
      list: async () => ({ data: [], cursor: {} }),
    },
  }, {
    record: async () => ({ threadId, latestTurnId: turnId }),
    recordTurnState: async (input: { state: string }) => {
      calls.push(`state:${input.state}`);
    },
  }, {}, {
    questionnaires: {
      canDeliver: () => true,
      deliver: async () => null,
      interruptRetainingQuestionnaire: async (
        candidateThreadId: string,
        requestKey: string,
        interrupt: () => Promise<boolean>,
      ) => {
        calls.push(`retain:${candidateThreadId}:${requestKey}`);
        return interrupt();
      },
    },
  });

  assert.equal(await owner.interactions.interruptRetaining({
    threadId,
    turnId,
    requestKey: "request",
  }, async () => true), true);
  assert.deepEqual(calls, [
    `retain:${threadId}:request`,
    `interrupt:${nativeThreadId}`,
    "state:interrupted",
  ]);
});
