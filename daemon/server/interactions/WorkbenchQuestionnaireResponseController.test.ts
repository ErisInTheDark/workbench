/*
 * No production exports. Tests protect daemon-owned questionnaire response routing, waiter liveness, delivery fencing, and settlement order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateQuestionnaireRepository from "../database/thread-state/WorkbenchThreadStateQuestionnaireRepository";

import type { JsonRpcRequest } from "../bridge-types";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import WorkbenchQuestionnaireResponseController, {
  type WorkbenchQuestionnaireResponseStatePort,
} from "./WorkbenchQuestionnaireResponseController";
import {
  NativeThreadIdSchema,
  NativeTurnIdSchema,
  WorkbenchThreadIdSchema,
  WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type {
  WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { WorkbenchSkillActivationMismatchError } from "workbench-shared/workbench/thread/thread-skill-mentions";

const projectId = testProjectIds.project;
const threadId = WorkbenchThreadIdSchema.parse("thread");
const nativeThreadId = NativeThreadIdSchema.parse("native-thread");
const turnId = WorkbenchTurnIdSchema.parse("turn");
const latestTurnId = WorkbenchTurnIdSchema.parse("latest-turn");
const admittedTurnId = WorkbenchTurnIdSchema.parse("admitted-turn");
const nativeAdmittedTurnId = NativeTurnIdSchema.parse("native-admitted-turn");
const response = { answers: { route: { answers: ["approve", "use /review"] } } };
const reviewSkill = { name: "review", description: "", path: "C:/skills/review/SKILL.md", relativePath: "skills/review/SKILL.md" };
const questionnaire = {
  itemId: "item",
  request: {
    id: "request",
    questions: [{
      allowOther: false,
      header: "route",
      id: "route",
      isSecret: false,
      options: [{ description: "continue", label: "approve" }],
      question: "continue?",
    }],
    submitLabel: "submit",
    summary: "",
    title: "questionnaire",
  },
  requestKey: "workbench-mcp:question",
  turnId,
};

function createHarness(lifecycle: WorkbenchThreadLifecycle, options: {
  admissionError?: string;
  admissionWarning?: string;
  admissionKind?: "started" | "steered";
  missingTurnIdentity?: boolean;
  liveApprovalKey?: string;
  deliverable?: boolean;
  harness?: "codex" | "copilot" | "opencode";
  latestTurnId?: typeof latestTurnId | null;
  pendingTurnId?: typeof turnId | null;
  requestKey?: string;
  virtualSteers?: WorkbenchUserInput[][];
  optionLabel?: string;
  providerPendingKey?: string;
} = {}) {
  const events: string[] = [];
  const requests: JsonRpcRequest[] = [];
  let historyTurnId: string | null = null;
  let settled = false;
  let pendingRequestKey: string | null = options.requestKey ?? questionnaire.requestKey;
  let stateQueue = Promise.resolve();
  const state: WorkbenchQuestionnaireResponseStatePort = {
    resolvePendingQuestionnaire: async (input, deliver) => {
      const previous = stateQueue;
      let release = () => {};
      stateQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (pendingRequestKey !== input.requestKey) return null;
        const pendingQuestionnaire = {
          ...questionnaire,
          ...(options.optionLabel ? { request: { ...questionnaire.request, questions: questionnaire.request.questions.map(question => ({
            ...question, options: [{ description: "", label: options.optionLabel! }],
          })) } } : {}),
          requestKey: pendingRequestKey!,
          turnId: options.pendingTurnId === undefined ? questionnaire.turnId : options.pendingTurnId,
        };
        const accepted = await deliver({ lifecycle, questionnaire: pendingQuestionnaire });
        const historyEntry = {
          ...pendingQuestionnaire,
          insertAfterItemId: accepted.insertAfterItemId,
          insertAfterItemIndex: accepted.insertAfterItemIndex,
          resolvedAt: input.resolvedAt,
          response: input.response,
          threadId,
          turnId: accepted.turnId,
        };
        historyTurnId = historyEntry.turnId;
        events.push("settled");
        pendingRequestKey = null;
        settled = true;
        return { delivery: accepted.delivery, historyEntry };
      } finally {
        release();
      }
    },
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation."); };
  const observe = (method: string, params: object) => {
    requests.push({ method, params });
    events.push(method);
  };
  const provider: WorkbenchProvider = {
    configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
    threads: {
      reconcile: unused, readLatest: unused, messageAgent: unused,
      latestTurn: unused, admitTurn: unused,
      history: { materialize: unused },
      create: unused, list: unused, read: unused, rename: unused,
      compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused,
      submit: async input => {
        observe("submit", input);
        if (options.admissionError) throw new Error(options.admissionError);
        if (options.missingTurnIdentity) throw new Error("The accepted turn has no canonical identity.");
        return options.admissionKind === "steered"
          ? { kind: "steered", turnId: admittedTurnId, warning: options.admissionWarning }
          : { kind: "started", warning: options.admissionWarning, turn: {
            id: admittedTurnId, status: "inProgress", items: [], itemsView: "full",
            error: null, startedAt: null, completedAt: null, durationMs: null,
          } };
      },
    },
    interactions: {
      interruptRetaining: unused,
      pending: async () => options.providerPendingKey ? [{
        harness: "codex", threadId, requestKey: options.providerPendingKey, turnId, itemId: null, request: questionnaire.request,
      }] : [],
      canDeliver: async () => options.deliverable ?? true,
      deliver: async () => { events.push("waiter"); return true; },
      respond: async input => { observe("respond", input); return {}; },
      supplement: async input => { observe("supplement", input); },
      record: async entry => { observe("record", entry); return {}; },
    },
  };
  const controller = new WorkbenchQuestionnaireResponseController({
    approvals: {
      owns: (_thread, key) => key === options.liveApprovalKey,
      list: () => options.liveApprovalKey ? [{
        harness: "codex", threadId, requestKey: options.liveApprovalKey, turnId, itemId: null, request: questionnaire.request,
      }] : [],
      respond: async input => { observe("approval", input); return { ok: true }; },
    },
    providers: { get: () => provider },
    harnesses: {
      resolveThreadIdentity: async () => ({
        bindings: [{
          harness: options.harness ?? "codex",
          nativeLocation: "C:/project",
          nativeThreadId,
          pending: false,
          turnIndex: 0,
        }],
        projectId,
        projectRoot: "C:/project",
        threadId,
      }),
    },
    resolveLatestTurn: async () => options.latestTurnId === undefined ? latestTurnId : options.latestTurnId,
    readSkills: async () => [reviewSkill],
    questionnaireSteers: {
      deliverWith: async (_thread, admit) => {
        const result = await admit(options.virtualSteers ?? []);
        if (options.virtualSteers?.length) events.push("steers retired");
        return result;
      },
    },
    state,
  });
  return { controller, events, historyTurnId: () => historyTurnId, requests, settled: () => settled };
}

function request() {
  return {
    activatedSkillPaths: ["C:/skills/review/SKILL.md"],
    harness: "codex" as const,
    projectId,
    requestKey: questionnaire.requestKey,
    response,
    supplementalInput: [
      { text: "extra context", text_elements: [], type: "text" as const },
      { type: "image" as const, url: "data:image/png;base64,aGVsbG8=" },
    ],
    threadId,
    turnId,
  };
}

test("admitted native turns settle questionnaire history under SQLite canonical foreign keys", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    const identities = new WorkbenchThreadIdentityRepository(database);
    const native = { harness: "codex" as const, nativeLocation: "C:/project", nativeThreadId };
    const thread = identities.observe({
      native, projectId, projectRoot: "C:/project", title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const turn = identities.observeTurn({
      kind: "turn", threadId: thread.threadId, turnId: nativeAdmittedTurnId,
      nativeTurnId: nativeAdmittedTurnId, nativeThreadId, nativeLocation: native.nativeLocation,
      harnessId: "codex", state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
    });
    assert.notEqual(turn.turnId, nativeAdmittedTurnId);
    database.prepare(`INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
      VALUES (?, 'topLevel', 'codex', 'thread', 1, 1)`).run(thread.threadId);
    const repository = new WorkbenchThreadStateQuestionnaireRepository(database);
    const pending = { ...questionnaire, turnId: null, itemId: null };
    repository.replace(thread.threadId, { pending, history: [] });
    const unused = async (): Promise<never> => { throw new Error("Unexpected operation."); };
    const controller = new WorkbenchQuestionnaireResponseController({
      approvals: { owns: () => false, list: () => [], respond: unused },
      providers: { get: () => ({
        configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
        threads: {
          reconcile: unused, readLatest: unused, messageAgent: unused,
          latestTurn: unused, admitTurn: unused,
          history: { materialize: unused },
          create: unused, list: unused, read: unused, rename: unused,
          compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused,
          submit: async () => ({ kind: "steered", turnId: turn.turnId }),
        },
        interactions: {
          interruptRetaining: unused,
          pending: unused,
          canDeliver: async () => false, deliver: async () => false,
          respond: unused, supplement: unused, record: async () => ({}),
        },
      }) },
      harnesses: {
        resolveThreadIdentity: async () => thread,
      },
      resolveLatestTurn: async () => null,
      readSkills: async () => [reviewSkill],
      questionnaireSteers: { deliverWith: (_thread, admit) => admit([]) },
      state: {
        resolvePendingQuestionnaire: async (input, deliver) => {
          const accepted = await deliver({ questionnaire: pending, lifecycle: { kind: "stopped", reason: "userMarkedStopped", settled: false } });
          const historyEntry = {
            ...pending, turnId: accepted.turnId, threadId: thread.threadId,
            insertAfterItemId: accepted.insertAfterItemId, insertAfterItemIndex: accepted.insertAfterItemIndex,
            resolvedAt: input.resolvedAt, response: input.response,
          };
          repository.replace(thread.threadId, { pending: null, history: [historyEntry] });
          return { delivery: accepted.delivery, historyEntry };
        },
      },
    });
    await controller.respond({ ...request(), threadId: thread.threadId });
    const stored = repository.read(thread.threadId);
    assert.equal(stored.pending, null);
    assert.equal(stored.history[0]?.turnId, turn.turnId);
    assert.deepEqual(stored.history[0]?.response, response);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("interrupted lifecycle admits even when the daemon still exposes an orphan waiter", async () => {
  const harness = createHarness({
    kind: "needsAttention",
    reason: "interrupted",
    turnId,
    settled: false,
  });

  const result = await harness.controller.respond(request());

  assert.equal(result.route, "admitted");
  assert.equal(harness.events.includes("waiter"), false);
  assert.deepEqual(harness.events.slice(0, 2), ["submit", "settled"]);
  const admission = harness.requests.find(({ method }) => method === "submit");
  const [answer, image] = (admission?.params as { input: WorkbenchUserInput[] }).input;
  assert.ok(answer?.type === "text" && answer.text.endsWith("</wb:questionnaire-response>\n\nextra context"), "extra text joins the answer");
  assert.deepEqual(image, request().supplementalInput[1]);
  assert.deepEqual(
    (admission?.params as { context?: { activatedSkillPaths?: string[] } } | undefined)?.context?.activatedSkillPaths,
    request().activatedSkillPaths,
  );
  assert.equal(harness.settled(), true);
  const recorded = harness.requests.find(({ method }) => method === "record");
  assert.equal((recorded?.params as { turnId?: string } | undefined)?.turnId, admittedTurnId);
  assert.equal((recorded?.params as { insertAfterItemId?: string | null } | undefined)?.insertAfterItemId, null);
});

test("blocked and completed questionnaires retain live answer delivery", async () => {
  for (const lifecycle of [
    { agent: { agentStatus: "blocked" as const, turnId }, kind: "needsAttention" as const, reason: "agentBlocked" as const, settled: false },
    { agent: { agentStatus: "completed" as const, turnId }, kind: "completed" as const, reason: "agentCompleted" as const, settled: false },
  ] satisfies WorkbenchThreadLifecycle[]) {
    const harness = createHarness(lifecycle);
    const result = await harness.controller.respond({ ...request(), supplementalInput: undefined, activatedSkillPaths: undefined });
    assert.equal(result.route, "live");
    assert.deepEqual(harness.events, ["waiter", "settled", "record"]);
  }
});

test("matching pending-input lifecycle resolves its live waiter before settlement", async () => {
  const harness = createHarness({
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey: questionnaire.requestKey,
    settled: false,
    turnId,
  }, { pendingTurnId: null });

  const result = await harness.controller.respond({ ...request(), activatedSkillPaths: undefined, supplementalInput: undefined });

  assert.equal(result.route, "live");
  assert.deepEqual(harness.events, ["waiter", "settled", "record"]);
  assert.equal(harness.requests.some(({ method }) => method === "submit"), false);
  const recorded = harness.requests.find(({ method }) => method === "record");
  assert.equal((recorded?.params as { turnId?: string } | undefined)?.turnId, latestTurnId);
  assert.equal((recorded?.params as { insertAfterItemId?: string | null } | undefined)?.insertAfterItemId, null);
});

test("missing live history placement leaves the ordinary questionnaire pending", async () => {
  const harness = createHarness({
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey: questionnaire.requestKey,
    settled: false,
  }, { latestTurnId: null, pendingTurnId: null });

  await assert.rejects(
    harness.controller.respond({ ...request(), activatedSkillPaths: undefined, supplementalInput: undefined }),
    /no history point/u,
  );

  assert.equal(harness.settled(), false);
  assert.deepEqual(harness.events, []);
});

test("detached admission stamps a steered response onto the accepted active turn", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { admissionKind: "steered", deliverable: false });

  const result = await harness.controller.respond(request());

  assert.equal(result.route, "admitted");
  const recorded = harness.requests.find(({ method }) => method === "record");
  assert.equal((recorded?.params as { turnId?: string } | undefined)?.turnId, admittedTurnId);
});

test("detached provider admission stamps its response onto the started turn", async () => {
  const requestKey = "provider-question";
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { requestKey, deliverable: false });

  const result = await harness.controller.respond({
    ...request(),
    requestKey,
  });

  assert.equal(result.route, "admitted");
  assert.equal(harness.historyTurnId(), admittedTurnId);
  assert.equal(harness.requests.some(({ method }) => method === "submit"), true);
});

test("provider questionnaire with pending lifecycle but no live waiter admits a continuation", async () => {
  const requestKey = "provider-question";
  const harness = createHarness({
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey,
    settled: false,
    turnId,
  }, { deliverable: false, requestKey });

  const result = await harness.controller.respond({ ...request(), requestKey });

  assert.equal(result.route, "admitted");
  assert.deepEqual(harness.events.slice(0, 2), ["submit", "settled"]);
  assert.equal(harness.requests.some(({ method }) => method === "respond"), false);
});

test("a held questionnaire's continuation is one message: the answer, then each virtual steer, retiring them once accepted", async () => {
  const requestKey = "provider-question";
  const text = (value: string) => ({ text: value, text_elements: [], type: "text" as const });
  const harness = createHarness({
    kind: "needsAttention", reason: "pendingInput", requestKey, settled: false, turnId,
  }, { deliverable: false, requestKey, virtualSteers: [[text("first")], [text("second")]] });

  await harness.controller.respond({ ...request(), requestKey, supplementalInput: [] });

  const submitted = harness.requests.find(({ method }) => method === "submit")?.params as { input: WorkbenchUserInput[] };
  assert.equal(submitted.input.length, 1);
  const [joined] = submitted.input;
  assert.ok(joined?.type === "text");
  assert.match(joined.text, /<\/wb:questionnaire-response>\n\nfirst\n\nsecond$/u);
  assert.deepEqual(harness.events.slice(0, 3), ["submit", "steers retired", "settled"]);
});

test("claimed skill activations in free-text answers are checked before any delivery; option labels are not skills", async () => {
  const harness = createHarness({
    kind: "needsAttention", reason: "pendingInput", requestKey: questionnaire.requestKey, settled: false, turnId,
  });
  const answer = (...answers: string[]) => ({ answers: { route: { answers } } });
  const rejected = await harness.controller.respond({
    ...request(), activatedSkillPaths: ["C:/gone/stale/SKILL.md"], response: answer("approve", "use /review"),
  }).catch(error => error);
  assert.ok(rejected instanceof WorkbenchSkillActivationMismatchError);
  assert.deepEqual(harness.events, []);

  const optionLabel = createHarness({
    kind: "needsAttention", reason: "pendingInput", requestKey: questionnaire.requestKey, settled: false, turnId,
  }, { optionLabel: "/review" });
  await optionLabel.controller.respond({ ...request(), activatedSkillPaths: [], response: answer("/review") });
  assert.equal(optionLabel.settled(), true);
});

test("live approval and provider-native answers check claimed skill activations before delivery", async () => {
  const lifecycle = {
    kind: "needsAttention", reason: "pendingInput", requestKey: questionnaire.requestKey, settled: false, turnId,
  } as const;
  const stale = { ...request(), activatedSkillPaths: ["C:/gone/stale/SKILL.md"] };
  const approval = createHarness(lifecycle, { liveApprovalKey: questionnaire.requestKey });
  assert.ok(await approval.controller.respond(stale).catch(error => error) instanceof WorkbenchSkillActivationMismatchError);
  assert.deepEqual(approval.events, []);

  const native = createHarness(lifecycle, { providerPendingKey: "native-question" });
  assert.ok(await native.controller.respond({ ...stale, requestKey: "native-question" }).catch(error => error)
    instanceof WorkbenchSkillActivationMismatchError);
  assert.deepEqual(native.events, []);

  const accepted = createHarness(lifecycle, { providerPendingKey: "native-question" });
  assert.equal((await accepted.controller.respond({ ...request(), requestKey: "native-question" })).route, "provider");
});

test("live approvals answer through their owner and never touch durable questionnaire state", async () => {
  const live = createHarness({
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey: questionnaire.requestKey,
    settled: false,
    turnId,
  }, { liveApprovalKey: questionnaire.requestKey });

  const result = await live.controller.respond(request());
  assert.equal(result.route, "live");
  assert.deepEqual(live.events, ["supplement", "approval"]);
  const steer = live.requests.find(({ method }) => method === "supplement");
  assert.equal((steer?.params as { turnId?: string } | undefined)?.turnId, turnId);
  assert.equal(live.settled(), false);
  assert.equal(live.requests.some(({ method }) => method === "record" || method === "submit"), false);
});

test("failed detached admission leaves durable settlement untouched", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { admissionError: "admission failed", deliverable: false });

  await assert.rejects(harness.controller.respond(request()), /admission failed/u);

  assert.equal(harness.settled(), false);
  assert.deepEqual(harness.events, ["submit"]);
});

test("missing accepted turn identity cannot settle history with a native id", async () => {
  const harness = createHarness({
    kind: "stopped", reason: "userMarkedStopped", settled: false,
  }, { missingTurnIdentity: true });
  await assert.rejects(harness.controller.respond(request()), /no canonical identity/u);
  assert.equal(harness.settled(), false);
  assert.equal(harness.requests.some(({ method }) => method === "record"), false);
});

test("a replaced request key cannot deliver or settle the old answer", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { requestKey: "workbench-mcp:replacement" });

  await assert.rejects(harness.controller.respond(request()), /no longer pending/u);

  assert.equal(harness.settled(), false);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.requests, []);
});

test("concurrent duplicate answers admit and settle exactly once", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { deliverable: false });

  const results = await Promise.allSettled([
    harness.controller.respond(request()),
    harness.controller.respond(request()),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(harness.requests.filter(({ method }) => method === "submit").length, 1);
  assert.equal(harness.requests.filter(({ method }) => method === "record").length, 1);
  assert.deepEqual(harness.events.slice(0, 2), ["submit", "settled"]);
});

test("accepted continuation warnings survive successful history recording without resending", async () => {
  const harness = createHarness({
    kind: "stopped", reason: "userMarkedStopped", settled: false,
  }, { admissionWarning: "Accepted, but provider metadata settlement failed." });
  const result = await harness.controller.respond(request());
  assert.equal(result.warning, "Accepted, but provider metadata settlement failed.");
  assert.equal(harness.requests.filter(({ method }) => method === "submit").length, 1);
  assert.equal(harness.settled(), true);
});
