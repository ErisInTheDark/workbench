/*
 * Exports: none. Tests protect cross-thread message admission, relationship and lock fences, and provider-independent Workbench questionnaire settlement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import * as identitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchQuestionnaireHistoryEntryState } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchProvider from "./WorkbenchProvider";
import WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import type { WorkbenchQuestionnaireResponseStatePort } from "./WorkbenchQuestionnaireResponseController";
import WorkbenchThreadMessageController from "./WorkbenchThreadMessageController";
import type { WorkbenchMessageWaitHandoff } from "./WorkbenchMessageWaitController";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";

const projectId = identitySchemas.ProjectIdSchema.parse("40fbf424-a0a0-4f05-b518-28b17d05fdd0");
const harness = "codex" satisfies WorkbenchHarness;

test("message waits reject unresolved sender names, unknown IDs, self aliases and a mismatched caller cwd", async () => {
  const { controller } = fixture();
  const request = { callerThreadId: "reviewer", cwd: "C:/repo", waitId: "lookup" };
  const signal = new AbortController().signal;
  await assert.rejects(controller.wait({ ...request, names: ["missing"] }, signal), /not found/u);
  await assert.rejects(controller.wait({ ...request, threadIds: ["missing"] }, signal), /no admitted identity/u);
  await assert.rejects(controller.wait({ ...request, threadIds: ["native-reviewer"] }, signal), /itself/u);
  await assert.rejects(controller.wait({ ...request, cwd: "C:/other", names: ["luna"] }, signal), /cwd project/u);
  await assert.rejects(controller.wait({ ...request, names: [], threadIds: [] }, signal), /At least one sender/u);
  await controller.dispose();
});

test("message waits resolve sender names and native aliases without imposing the caller's project on senders", async () => {
  for (const targets of [
    { names: ["luna"], threadIds: ["native-child", "child"] },
    { threadIds: ["native-target"] },
    { names: ["nova"] },
  ]) {
    const armed = Promise.withResolvers<void>();
    type WaitState = Parameters<WorkbenchMessageWaitHandoff["waits"]["set"]>[1];
    const waits = new class extends Map<string, WaitState> {
      override set(key: string, value: WaitState) {
        super.set(key, value);
        armed.resolve();
        return this;
      }
    }();
    const { controller } = fixture({ targetCwd: "C:/other", withSibling: true, waitHandoff: { waits } });
    const waited = controller.wait({
      ...targets, callerThreadId: "native-reviewer", cwd: "C:/repo", waitId: "canonical-senders",
    }, new AbortController().signal);
    await armed.promise;
    const senderThreadId = targets.names?.[0] === "luna" ? "child" : "target";
    const reply = { senderThreadId, senderName: "sender", message: "canonical reply" };
    controller.receive("reviewer", reply);
    assert.deepEqual(await waited, { kind: "message", message: reply });
    await controller.dispose();
  }
});

function thread(id: string, cwd: string, active = false, name: string | null = null): ThreadPayload {
  return {
    agentNickname: null, agentRole: null, createdAt: 1, cwd, harness,
    id: identitySchemas.WorkbenchThreadIdSchema.parse(id), name,
    model: null, reasoningEffort: null, path: null, preview: "", recencyAt: null,
    agentPath: null, tokenUsage: null, turnHistory: [], serviceTier: null, isDraft: false,
    source: "appServer", status: active ? "active" : "idle",
    turns: [{
      completedAt: active ? null : 2, durationMs: null, error: null, id: `turn-${id}`, items: [], itemsView: "full",
      startedAt: 1, status: active ? "inProgress" : "completed",
    }], updatedAt: 2,
  };
}

function fixture({
  activeChild = false,
  childCwd = "C:/repo",
  childHarness = harness,
  childPinned = false,
  deliveryGate,
  metadataOnly = false,
  onDelivery,
  questionnaires,
  questionnaireState,
  rejectDelivery = false,
  targetCwd = "C:/repo",
  withSibling = false,
  waitHandoff,
}: {
  activeChild?: boolean;
  childCwd?: string;
  childHarness?: WorkbenchHarness;
  childPinned?: boolean;
  deliveryGate?: Promise<void>;
  metadataOnly?: boolean;
  onDelivery?: () => void | Promise<void>;
  questionnaires?: WorkbenchQuestionnaireController;
  questionnaireState?: WorkbenchThreadStateController;
  rejectDelivery?: boolean;
  targetCwd?: string;
  withSibling?: boolean;
  waitHandoff?: WorkbenchMessageWaitHandoff;
} = {}) {
  const calls: Array<{ method: string; params: object }> = [];
  const threads = new Map([
    ["reviewer", thread("reviewer", "C:/repo", false, "review cancellation")],
    ["target", thread("target", targetCwd)],
    ["child", {
      ...thread("child", childCwd, activeChild, "child review"),
      harness: childHarness,
      ...(metadataOnly ? { turns: [] } : {}),
    }],
  ]);
  const projectFor = (cwd: string) => cwd === "C:/other" ? identitySchemas.ProjectIdSchema.parse("other") : projectId;
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1, cwd: childCwd, directSubagentIndex: 0, harness: childHarness, name: "luna",
    parentThreadId: identitySchemas.WorkbenchThreadIdSchema.parse("reviewer"),
    profileId: "profile", profileName: "reviewer", projectId: projectFor(childCwd),
    threadId: identitySchemas.WorkbenchThreadIdSchema.parse("child"), title: "child", updatedAt: 1,
  };
  const unused = async () => { throw new Error("unexpected provider operation"); };
  const provider: Pick<WorkbenchProvider, "threads" | "interactions"> = {
    threads: {
      reconcile: unused,
      read: async id => threads.get(id) ?? (() => { throw new Error(`unknown thread ${id}`); })(),
      readLatest: async id => threads.get(id) ?? (() => { throw new Error(`unknown thread ${id}`); })(),
      latestTurn: unused, admitTurn: unused, history: { materialize: unused }, create: unused,
      messageAgent: async input => {
        calls.push({ method: "messageAgent", params: input });
        await onDelivery?.();
        await deliveryGate;
        if (rejectDelivery) throw new Error("delivery rejected");
        return { kind: threads.get(input.threadId)?.status === "active" ? "steered" : "started", turnId: `delivered-${input.threadId}` };
      },
      rename: unused, list: unused, submit: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused,
    },
    interactions: {
      pending: async () => {
        if (questionnaires) {
          const entry = await questionnaireState!.getCanonicalThreadEntry(projectId, relationship.threadId);
          if (entry && entry.entryKind !== "draft" && entry.pendingQuestionnaire) {
            throw new Error("Workbench questions must not use provider discovery.");
          }
          return [];
        }
        return activeChild ? [{
        harness, requestKey: "question", threadId: relationship.threadId, turnId: "turn-child", itemId: "item",
        request: { id: "question", title: "review", summary: "", submitLabel: "send", questions: [{
          id: "choice", header: "", question: "continue?", options: [], allowOther: true, isSecret: false,
        }] },
        }] : [];
      },
      respond: async input => {
        if (questionnaires) throw new Error("Workbench questions must not use provider responses.");
        calls.push({ method: "respond", params: input }); return {};
      },
      interruptRetaining: unused, canDeliver: unused, deliver: unused, supplement: unused, record: unused,
    },
  };
  const identity = (threadId: string) => ({
    bindings: [{
      harness: threads.get(threadId)!.harness, nativeLocation: "C:/repo", nativeThreadId: identitySchemas.NativeThreadIdSchema.parse(`native-${threadId}`),
      pending: false, turnIndex: null,
    }],
    projectId,
    projectRoot: "C:/repo",
    threadId: identitySchemas.WorkbenchThreadIdSchema.parse(threadId),
  });
  const canonicalId = (threadId: string) => threadId.startsWith("native-") ? threadId.slice("native-".length) : threadId;
  const controller = new WorkbenchThreadMessageController({
    identities: {
      resolve: async ({ threadId }) => {
        const canonical = canonicalId(threadId);
        return threads.has(canonical) ? identity(canonical) : null;
      },
    },
    listSubagents: async selected => ({
      subagents: selected === relationship.projectId
        ? [relationship, ...(withSibling ? [{ ...relationship, cwd: targetCwd, name: "nova", threadId: identitySchemas.WorkbenchThreadIdSchema.parse("target") }] : [])]
        : [],
    }),
    provider: selected => { assert.ok(selected === harness || selected === childHarness); return provider; },
    questionnaires: questionnaires ?? { canDeliver: () => false, deliver: unused },
    recordQuestionnaire: async (entry: WorkbenchQuestionnaireHistoryEntryState) => {
      calls.push({ method: "recordQuestionnaire", params: entry });
    },
    resolveProjectFromCwd: async cwd => ({
      cwd: cwd ?? "",
      project: {
        id: projectFor(cwd ?? ""),
        kind: "git", root: cwd ?? "", rootPath: cwd ?? "", roots: [],
      },
      root: { id: "root", name: "repo", root: cwd ?? "", rootPath: cwd ?? "" },
    }),
    threadState: {
      getEntry: async (selected, selectedHarness, threadId) => questionnaireState
        ? questionnaireState.getThreadEntry(selected, selectedHarness, threadId)
        : (
        selected === relationship.projectId && threadId === relationship.threadId
      ) ? {
        activityAt: 2, createdAt: 1, cwd: childCwd, directSubagentIndex: 0, entryKind: "subagent",
        identity: { harness: childHarness, threadId: relationship.threadId },
        lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
        name: relationship.name, parentThreadId: relationship.parentThreadId, pinned: childPinned,
        profileId: relationship.profileId, profileName: relationship.profileName, projectId: relationship.projectId, title: relationship.title, updatedAt: 2,
      } : null,
      acceptAdmission: async (selected, selectedHarness, threadId, admitted) => {
        calls.push({ method: "acceptAdmission", params: { projectId: selected, harness: selectedHarness, threadId, admitted } });
        await questionnaireState?.acceptAdmission(selected, selectedHarness, threadId, {
          kind: admitted.kind, turnId: identitySchemas.WorkbenchTurnIdSchema.parse(admitted.turnId),
        });
      },
      resolvePendingQuestionnaire: questionnaireState
        ? questionnaireState.resolvePendingQuestionnaire.bind(questionnaireState)
        : (async () => null) satisfies WorkbenchQuestionnaireResponseStatePort["resolvePendingQuestionnaire"],
    },
  }, waitHandoff);
  return { calls, controller };
}

async function questionnaireFixture(childHarness: WorkbenchHarness, options: {
  detached?: boolean;
  rejectDelivery?: boolean;
  replaceOnAnswer?: boolean;
  replaceDuringMessage?: boolean;
} = {}) {
  const threadId = identitySchemas.WorkbenchThreadIdSchema.parse("child");
  const turnId = identitySchemas.WorkbenchTurnIdSchema.parse("turn-child");
  const question = {
    itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44",
    requestKey: "workbench-mcp:question",
    turnId,
    request: {
      id: "workbench-mcp:question", title: "review", summary: "", submitLabel: "send",
      questions: [{ id: "choice", header: "choice", question: "continue?", options: [], allowOther: true, isSecret: false }],
    },
  };
  const record: WorkbenchThreadStateRecord = {
    activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: childHarness, threadId },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: question.requestKey, turnId, settled: false },
    name: "luna", parentThreadId: identitySchemas.WorkbenchThreadIdSchema.parse("reviewer"), pinned: false,
    profileId: "profile", profileName: "reviewer", projectId, title: "child", updatedAt: 2,
    pendingQuestionnaire: question, gitHistoryCleanedAt: null, mcpGeneration: null, profile: null,
    providerObserved: true, settledAt: null, snoozedUntil: null,
  };
  const database = createThreadStateTestDatabase();
  await database.seedProject(projectId, { version: 4, records: [record], drafts: [] });
  database.admitRecord({
    ...record,
    lifecycle: {
      kind: "working", reason: "acceptedIntent", settled: false,
      agent: { agentStatus: "working", turnId: identitySchemas.WorkbenchTurnIdSchema.parse("delivered-child") },
    },
  });
  const state = new WorkbenchThreadStateController({
    threadStateStore: database.persistence,
    resolveProjectId: id => id,
    hasGitArcBlockingSettlement: async () => false,
    resolveGitArc: async () => null,
    resolveGitArcPlan: async () => null,
    runGitArcReadTransition: async (_projectId, operation) => operation(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/repo" }),
    reconcileProject: async () => [],
  });
  await state.readProject(projectId);
  const read = async () => {
    const entry = await state.getCanonicalThreadEntry(projectId, threadId);
    assert.ok(entry && entry.entryKind !== "draft");
    return entry;
  };
  const replacement = {
    ...question, requestKey: options.replaceDuringMessage ? question.requestKey : "workbench-mcp:replacement",
    itemId: "984090b6-1d94-44cc-ab26-e6470965597e",
  };
  const replace = async () => {
    await database.identities.items.admit([{
      threadId, itemId: identitySchemas.WorkbenchItemIdSchema.parse(replacement.itemId), sources: [],
    }]);
    await state.setPendingQuestionnaire(projectId, threadId, replacement);
  };
  let published!: () => void;
  const ready = new Promise<void>(resolve => { published = resolve; });
  const questionnaires = new WorkbenchQuestionnaireController({
    beforeAnswer: options.replaceOnAnswer ? replace : undefined,
    clearPending: async (_threadId, requestKey, answered) => {
      await state.clearPendingQuestionnaire(projectId, threadId, requestKey, answered);
    },
    resolveThread: async () => ({
      projectId, turnId,
      pendingQuestionnaire: (await read()).pendingQuestionnaire,
    }),
    publishPending: async (_threadId, pending) => {
      await state.setPendingQuestionnaire(projectId, threadId, pending);
      published();
    },
    subscribePending: listener => state.subscribe((selectedProjectId, entry) => {
      if (entry.entryKind === "draft") return;
      listener({
        projectId: selectedProjectId, threadId: entry.identity.threadId,
        requestKey: entry.pendingQuestionnaire?.requestKey ?? null,
      });
    }),
  });
  const abort = new AbortController();
  const answer = questionnaires.request({
    callerThreadId: threadId, cwd: "C:/repo", requestKey: question.requestKey,
    questions: [{ id: "choice", header: "choice", question: "continue?", options: [] }],
  }, abort.signal).then(response => ({ response }), error => ({ error }));
  await ready;
  if (options.detached) {
    abort.abort(new Error("caller detached"));
    assert.ok("error" in await answer);
  }
  const messaging = fixture({
    activeChild: !options.detached, childHarness, metadataOnly: true, questionnaires, questionnaireState: state,
    rejectDelivery: options.rejectDelivery,
    onDelivery: options.replaceDuringMessage ? replace : undefined,
  });
  return {
    ...messaging, answer, question, replacement,
    read,
    async dispose() {
      await messaging.controller.dispose();
      await questionnaires.dispose();
      await state.dispose();
    },
  };
}

for (const childHarness of installedProviderKeys) {
  test(`${childHarness} parent messages settle shared questionnaires without provider discovery or turn history`, async () => {
    for (const target of [{ threadId: "child" }, { name: "luna" }]) {
      const h = await questionnaireFixture(childHarness);
      try {
        const request = { callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", userVisibleSimpleVersion: "Continue.", ...target };
        await h.controller.send(request);
        assert.equal((await h.read())?.pendingQuestionnaire, null);
        assert.deepEqual(await h.answer, { response: { answers: { choice: { answers: [] } } } });
        const settled = (await h.read())?.questionnaireHistory?.[0];
        assert.equal(settled?.turnId, "delivered-child");
        assert.deepEqual(settled?.response, { answers: { choice: { answers: [] } } });
        assert.deepEqual(h.calls.find(call => call.method === "recordQuestionnaire")?.params, settled);
        const delivery = h.calls.find(call => call.method === "messageAgent")?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
        assert.equal(delivery.context, undefined);
        await h.controller.send(request);
        assert.equal((await h.read())?.questionnaireHistory?.length, 1);
        assert.equal(h.calls.filter(call => call.method === "recordQuestionnaire").length, 1);
      } finally { await h.dispose(); }
    }
  });

  test(`${childHarness} parent messages settle detached questionnaires on the admitted message turn`, async () => {
    const h = await questionnaireFixture(childHarness, { detached: true });
    try {
      await h.controller.send({
        callerThreadId: "reviewer", cwd: "C:/repo", message: "Resume.", userVisibleSimpleVersion: "Resume.", threadId: "child",
      });
      assert.equal((await h.read())?.pendingQuestionnaire, null);
      assert.equal((await h.read())?.questionnaireHistory?.[0]?.turnId, "delivered-child");
      assert.equal(h.calls.filter(call => call.method === "messageAgent").length, 1);
    } finally { await h.dispose(); }
  });
}

test("failed parent message admission retains the shared questionnaire and its live wait", async () => {
  const h = await questionnaireFixture("codex", { rejectDelivery: true });
  try {
    await assert.rejects(h.controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", userVisibleSimpleVersion: "Continue.", threadId: "child",
    }), /delivery rejected/u);
    assert.equal((await h.read())?.pendingQuestionnaire?.requestKey, h.question.requestKey);
    assert.equal((await h.read())?.questionnaireHistory?.length ?? 0, 0);
    assert.equal(h.calls.some(call => call.method === "recordQuestionnaire"), false);
  } finally { await h.dispose(); }
});

test("settling a parent message's question preserves a replacement published during answer delivery", async () => {
  const h = await questionnaireFixture("codex", { replaceOnAnswer: true });
  try {
    await h.controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", userVisibleSimpleVersion: "Continue.", threadId: "child",
    });
    assert.equal((await h.read())?.pendingQuestionnaire?.requestKey, h.replacement.requestKey);
    assert.equal((await h.read())?.questionnaireHistory?.[0]?.requestKey, h.question.requestKey);
    assert.deepEqual(await h.answer, { response: { answers: { choice: { answers: [] } } } });
  } finally { await h.dispose(); }
});

test("a non-parent message leaves a shared questionnaire pending", async () => {
  const h = await questionnaireFixture("codex");
  try {
    await h.controller.send({
      callerThreadId: "target", cwd: "C:/repo", message: "Peer note.", userVisibleSimpleVersion: "Peer note.", threadId: "child",
    });
    assert.equal((await h.read())?.pendingQuestionnaire?.requestKey, h.question.requestKey);
    assert.equal((await h.read())?.questionnaireHistory?.length ?? 0, 0);
  } finally { await h.dispose(); }
});

test("parent messages do not settle a replacement that reused the captured request key", async () => {
  const h = await questionnaireFixture("codex", { replaceDuringMessage: true });
  try {
    await h.controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", userVisibleSimpleVersion: "Continue.", threadId: "child",
    });
    assert.equal((await h.read()).pendingQuestionnaire?.itemId, h.replacement.itemId);
    assert.equal((await h.read()).questionnaireHistory?.length ?? 0, 0);
    assert.equal(h.calls.some(call => call.method === "recordQuestionnaire"), false);
  } finally { await h.dispose(); }
});

test("messages an arbitrary thread with caller title attribution", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Please fix the cancellation race.", threadId: "target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.deepEqual(delivery.message, {
    message: "Please fix the cancellation race.", senderName: "review cancellation", senderThreadId: "reviewer",
    userVisibleSimpleVersion: "Summary.",
  });
  assert.equal(calls.some(({ method }) => method === "respond"), false);
  await controller.dispose();
});

test("relationship shortcuts preserve child and parent attribution", async () => {
  const child = fixture();
  await child.controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Continue safely.", name: "luna",
    workbenchOrigin: "http://localhost:3000",
  });
  const childDelivery = child.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(childDelivery.threadId, "child");
  assert.equal(childDelivery.message.senderName, "parent agent");
  assert.deepEqual(childDelivery.context, {
    subagentName: "luna", workbenchOrigin: "http://localhost:3000", workflowIds: ["subagent"],
  });
  await child.controller.dispose();

  const parent = fixture();
  await parent.controller.send({
    callerThreadId: "child", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Review ready.", parent: true,
  });
  const parentDelivery = parent.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(parentDelivery.threadId, "reviewer");
  assert.deepEqual(parentDelivery.message, {
    message: "Review ready.", senderName: "luna", senderThreadId: "child", userVisibleSimpleVersion: "Summary.",
  });
  await parent.controller.dispose();
});

test("subagents reach unsettled siblings by name without reaching other parents' children", async () => {
  const sibling = fixture({ withSibling: true });
  await sibling.controller.send({ callerThreadId: "child", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message: "Peer note.", name: "NOVA" });
  const delivery = sibling.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.threadId, "target");
  assert.equal(delivery.message.senderThreadId, "child");
  await sibling.controller.dispose();

  const outsider = fixture();
  await assert.rejects(
    outsider.controller.send({ callerThreadId: "target", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message: "Hi.", name: "luna" }),
    /unsettled subagent name was not found/u,
  );
  await outsider.controller.dispose();
});

test("an admitted agent message moves its target by how the provider admitted it", async () => {
  for (const activeChild of [false, true]) {
    const { calls, controller } = fixture({ activeChild });
    await controller.send({ callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Another pass.", threadId: "child" });
    // A steer into a live turn must not read as a started turn, or it would drop that turn's questionnaire.
    assert.deepEqual(calls.find(({ method }) => method === "acceptAdmission")?.params, {
      projectId, harness, threadId: "child", admitted: { kind: activeChild ? "steered" : "started", turnId: "delivered-child" },
    });
    await controller.dispose();
  }
});

test("subagent messages to arbitrary peers use the caller thread title", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "child", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Peer review ready.", threadId: "target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.message.senderName, "child review");
  await controller.dispose();
});

test("message admission emits canonical thread identities", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "native-reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Canonical feedback.", threadId: "native-target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.threadId, "target");
  assert.equal(delivery.message.senderThreadId, "reviewer");
  await controller.dispose();
});

test("direct-child messages retain questionnaire ordering and lock fencing", async () => {
  const active = fixture({ activeChild: true });
  await active.controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Continue with the review.", threadId: "child",
  });
  assert.deepEqual(active.calls.map(({ method }) => method), ["messageAgent", "acceptAdmission", "respond"]);
  const delivery = active.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.message.senderName, "parent agent");
  await active.controller.dispose();

  const locked = fixture({ childPinned: true });
  await assert.rejects(
    locked.controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Continue.", threadId: "child",
    }),
    /locked/u,
  );
  assert.equal(locked.calls.length, 0);
  await locked.controller.dispose();
});

test("failed direct-child delivery leaves its questionnaire pending", async () => {
  const { calls, controller } = fixture({ activeChild: true, rejectDelivery: true });
  await assert.rejects(
    controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Continue.", threadId: "child",
    }),
    /delivery rejected/u,
  );
  assert.deepEqual(calls.map(({ method }) => method), ["messageAgent"]);
  await controller.dispose();
});

test("thread messages deliver to targets in another project", async () => {
  const { calls, controller } = fixture({ targetCwd: "C:/other" });
  await controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Cross the wall.", threadId: "target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.threadId, "target");
  assert.equal(delivery.cwd, "C:/other");
  await controller.dispose();
});

test("locked subagents in another project stay fenced", async () => {
  const { calls, controller } = fixture({ childCwd: "C:/other", childPinned: true });
  await assert.rejects(
    controller.send({
      callerThreadId: "target", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Continue.", threadId: "child",
    }),
    /locked/u,
  );
  assert.equal(calls.length, 0);
  await controller.dispose();
});

test("callers outside the request cwd project are rejected", async () => {
  const { controller } = fixture({ targetCwd: "C:/other" });
  await assert.rejects(
    controller.send({
      callerThreadId: "target", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Spoofed caller.", threadId: "reviewer",
    }),
    /does not belong/u,
  );
  await controller.dispose();
});

test("parent targeting rejects callers without a direct relationship", async () => {
  const { controller } = fixture();
  await assert.rejects(
    controller.send({
      callerThreadId: "target", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Spoofed note.", parent: true,
    }),
    /not a Workbench subagent/u,
  );
  await controller.dispose();
});

test("message disposal drains admitted delivery and rejects new admission", async () => {
  let entered!: () => void;
  const delivering = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { controller } = fixture({ deliveryGate: gate, onDelivery: entered });
  const request = {
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Review feedback.", threadId: "target",
  };
  const delivery = controller.send(request);
  await delivering;
  let disposed = false;
  const disposal = controller.dispose().then(() => { disposed = true; });
  await assert.rejects(controller.send(request), /draining/u);
  assert.equal(disposed, false);
  release();
  await delivery;
  await disposal;
});

test("message admission is synchronous with respect to runtime drain", async () => {
  const { controller } = fixture();
  const request = {
    callerThreadId: "reviewer", cwd: "C:/repo", userVisibleSimpleVersion: "Summary.", message:"Review feedback.", threadId: "target",
  };
  const delivery = controller.send(request);
  const disposal = controller.dispose();
  await delivery;
  await disposal;
});
