/*
 * Exports: none. Tests protect global thread-message admission, relationship semantics and project fencing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import * as identitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type WorkbenchProvider from "./WorkbenchProvider";
import WorkbenchThreadMessageController from "./WorkbenchThreadMessageController";

const projectId = identitySchemas.ProjectIdSchema.parse("project");
const harness = "codex" satisfies WorkbenchHarness;

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
  childPinned = false,
  deliveryGate,
  onDelivery,
  rejectDelivery = false,
  targetCwd = "C:/repo",
}: {
  activeChild?: boolean;
  childPinned?: boolean;
  deliveryGate?: Promise<void>;
  onDelivery?: () => void;
  rejectDelivery?: boolean;
  targetCwd?: string;
} = {}) {
  const calls: Array<{ method: string; params: object }> = [];
  const threads = new Map([
    ["reviewer", thread("reviewer", "C:/repo", false, "review cancellation")],
    ["target", thread("target", targetCwd)],
    ["child", thread("child", "C:/repo", activeChild, "child review")],
  ]);
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, harness, name: "luna",
    parentThreadId: identitySchemas.WorkbenchThreadIdSchema.parse("reviewer"),
    profileId: "profile", profileName: "reviewer", projectId,
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
        onDelivery?.();
        await deliveryGate;
        if (rejectDelivery) throw new Error("delivery rejected");
      },
      rename: unused, list: unused, submit: unused, compact: unused, interrupt: unused, materialize: unused,
    },
    interactions: {
      pending: async () => activeChild ? [{
        harness, requestKey: "question", threadId: relationship.threadId, turnId: "turn-child", itemId: "item",
        request: { id: "question", title: "review", summary: "", submitLabel: "send", questions: [{
          id: "choice", header: "", question: "continue?", options: [], allowOther: true, isSecret: false,
        }] },
      }] : [],
      respond: async input => { calls.push({ method: "respond", params: input }); return {}; },
      interruptRetaining: unused, canDeliver: unused, deliver: unused, supplement: unused, record: unused,
    },
  };
  const identity = (threadId: string) => ({
    bindings: [{
      harness, nativeLocation: "C:/repo", nativeThreadId: identitySchemas.NativeThreadIdSchema.parse(`native-${threadId}`),
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
    listSubagents: async () => ({ subagents: [relationship] }),
    provider: selected => { assert.equal(selected, harness); return provider; },
    resolveProjectFromCwd: async cwd => ({
      cwd: cwd ?? "",
      project: {
        id: cwd === "C:/other" ? identitySchemas.ProjectIdSchema.parse("other") : projectId,
        kind: "git", root: cwd ?? "", rootPath: cwd ?? "", roots: [],
      },
      root: { id: "root", name: "repo", root: cwd ?? "", rootPath: cwd ?? "" },
    }),
    threadState: {
      getEntry: async (_projectId, _harness, threadId) => threadId === relationship.threadId ? {
        activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
        identity: { harness, threadId: relationship.threadId },
        lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
        name: relationship.name, parentThreadId: relationship.parentThreadId, pinned: childPinned,
        profileId: relationship.profileId, profileName: relationship.profileName, projectId, title: relationship.title, updatedAt: 2,
      } : null,
    },
  });
  return { calls, controller };
}

test("messages an arbitrary same-project thread with caller title attribution", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", message: "Please fix the cancellation race.", threadId: "target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.deepEqual(delivery.message, {
    message: "Please fix the cancellation race.", senderName: "review cancellation", senderThreadId: "reviewer",
  });
  assert.equal(calls.some(({ method }) => method === "respond"), false);
  await controller.dispose();
});

test("relationship shortcuts preserve child and parent attribution", async () => {
  const child = fixture();
  await child.controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue safely.", name: "luna",
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
    callerThreadId: "child", cwd: "C:/repo", message: "Review ready.", parent: true,
  });
  const parentDelivery = parent.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(parentDelivery.threadId, "reviewer");
  assert.deepEqual(parentDelivery.message, {
    message: "Review ready.", senderName: "luna", senderThreadId: "child",
  });
  await parent.controller.dispose();
});

test("subagent messages to arbitrary peers use the caller thread title", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "child", cwd: "C:/repo", message: "Peer review ready.", threadId: "target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.message.senderName, "child review");
  await controller.dispose();
});

test("message admission emits canonical thread identities", async () => {
  const { calls, controller } = fixture();
  await controller.send({
    callerThreadId: "native-reviewer", cwd: "C:/repo", message: "Canonical feedback.", threadId: "native-target",
  });
  const delivery = calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.threadId, "target");
  assert.equal(delivery.message.senderThreadId, "reviewer");
  await controller.dispose();
});

test("direct-child messages retain questionnaire ordering and lock fencing", async () => {
  const active = fixture({ activeChild: true });
  await active.controller.send({
    callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue with the review.", threadId: "child",
  });
  assert.deepEqual(active.calls.map(({ method }) => method), ["messageAgent", "respond"]);
  const delivery = active.calls[0]?.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
  assert.equal(delivery.message.senderName, "parent agent");
  await active.controller.dispose();

  const locked = fixture({ childPinned: true });
  await assert.rejects(
    locked.controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", threadId: "child",
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
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Continue.", threadId: "child",
    }),
    /delivery rejected/u,
  );
  assert.deepEqual(calls.map(({ method }) => method), ["messageAgent"]);
  await controller.dispose();
});

test("thread messages reject targets outside the caller cwd project", async () => {
  const { controller } = fixture({ targetCwd: "C:/other" });
  await assert.rejects(
    controller.send({
      callerThreadId: "reviewer", cwd: "C:/repo", message: "Cross the wall.", threadId: "target",
    }),
    /does not belong/u,
  );
  await controller.dispose();
});

test("parent targeting rejects callers without a direct relationship", async () => {
  const { controller } = fixture();
  await assert.rejects(
    controller.send({
      callerThreadId: "target", cwd: "C:/repo", message: "Spoofed note.", parent: true,
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
    callerThreadId: "reviewer", cwd: "C:/repo", message: "Review feedback.", threadId: "target",
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
    callerThreadId: "reviewer", cwd: "C:/repo", message: "Review feedback.", threadId: "target",
  };
  const delivery = controller.send(request);
  const disposal = controller.dispose();
  await delivery;
  await disposal;
});
