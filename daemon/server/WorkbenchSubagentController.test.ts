/*
 * Exports: none. Tests protect message transport through the subagent owner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadPayload, WorkbenchComposerProfile, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import type { JsonRpcRequest } from "./bridge-types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
  },
};

function thread(id: string, active: boolean): ThreadPayload {
  return {
    agentNickname: null, agentRole: null, createdAt: 1, cwd: "C:/repo", harness: "test-provider",
    id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), name: null,
    model: null, reasoningEffort: null, path: null, preview: "", recencyAt: null,
    agentPath: null, tokenUsage: null, turnHistory: [], serviceTier: null, isDraft: false,
    source: "appServer", status: active ? "active" : "idle",
    turns: [{
      completedAt: active ? null : 2, durationMs: null, error: null, id: `turn-${id}`, items: [], itemsView: "full",
      startedAt: 1, status: active ? "inProgress" : "completed",
    }], updatedAt: 2,
  };
}

type Route = "create" | "child-active" | "child-idle" | "parent-active" | "parent-idle";

async function exercise(route: Route, harness: WorkbenchHarness, rejectDelivery = false, publicIds = false) {
  const requests: JsonRpcRequest[] = [];
  const identities = new Map(["parent", "child"].map(name => {
    const record = {
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(publicIds ? `public-${name}` : name),
      projectId: fixtureIdentityValues.ProjectId.project,
      projectRoot: "C:/repo",
      bindings: [{
        harness, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(`native-${name}`),
        nativeLocation: "C:/repo", pending: true, turnIndex: null,
      }],
    };
    return [name, record] as const;
  }));
  const knownThread = (reference: string) => {
    const record = [...identities.values()].find(record => record.threadId === reference || record.bindings[0].nativeThreadId === reference)
      ?? identities.get(reference);
    if (!record) throw new Error(`Unknown fixture thread ${reference}`);
    return record;
  };
  const profile: WorkbenchComposerProfile = {
    agentPath: null, agentSource: null, createdAt: 1, harness, id: "profile", model: "test-model", name: "test profile",
    reasoningEffort: "low", scope: { kind: "global" }, serviceTier: null, updatedAt: 1,
  };
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1, cwd: "C:/repo", directSubagentIndex: 1, harness, name: "iris", parentThreadId: knownThread("parent").threadId,
    profileId: profile.id, profileName: profile.name, projectId: fixtureIdentityValues.ProjectId["project"], threadId: knownThread("child").threadId, title: "review", updatedAt: 1,
  };
  let relationships = route === "create" ? [] : [relationship];
  const unused = async () => { throw new Error("unexpected provider operation"); };
  const read = async (id: string) => thread(knownThread(id).threadId, route.endsWith("active"));
  const provider: Pick<WorkbenchProvider, "threads" | "interactions"> = {
    threads: {
      read, readLatest: read, latestTurn: unused, admitTurn: unused,
      history: { materialize: unused },
      create: async input => {
        requests.push({ method: "create", params: input });
        return thread(knownThread("child").threadId, false);
      },
      messageAgent: async input => {
        requests.push({ method: "messageAgent", params: input });
        if (rejectDelivery) throw new Error("delivery rejected");
      },
      rename: async () => {}, list: unused, submit: unused,
      compact: unused, interrupt: unused, materialize: unused,
    },
    interactions: {
      pending: async () => route === "child-active" ? [{
        harness, requestKey: "question", threadId: knownThread("child").threadId, turnId: "turn-child", itemId: "item",
        request: { id: "question", title: "review", summary: "", submitLabel: "send", questions: [{
          id: "choice", header: "", question: "continue?", options: [], allowOther: true, isSecret: false,
        }] },
      }] : [],
      respond: async input => { requests.push({ method: "respond", params: input }); return {}; },
      interruptRetaining: unused, canDeliver: unused, deliver: unused, supplement: unused, record: unused,
    },
  };
  const controller = new WorkbenchSubagentController({
    provider: selected => { assert.equal(selected, harness); return provider; },
    identities: { resolve: async ({ threadId }) => knownThread(threadId), knownThread },
    publicThreadId: async threadId => knownThread(threadId).threadId,
    onRelationshipCommitted: async () => {},
    profileStore: {
      read: async () => ({ profiles: [profile] }),
      mutate: async () => { throw new Error("profile mutation is not message admission"); },
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    subagentStore: {
      getOwned: async (parent, project, id) => relationships.find((record) => record.parentThreadId === parent && record.projectId === project && record.threadId === id) ?? null,
      getOwnedMany: async () => [],
      list: async () => ({ nextCursor: null, subagents: relationships }),
      remove: async () => {},
      replace: async (_parent, _previous, record) => { relationships = [record]; },
      reserve: async (record) => ({ ...record, directSubagentIndex: 1 }),
    },
  });
  const message = "check cancellation ownership";
  try {
    const response = await controller.handleRequest({
      id: 1, method: route === "create" ? "workbench/subagent/create" : "workbench/subagent/message",
      params: {
        callerThreadId: route.startsWith("parent") ? "child" : "parent", cwd: "C:/repo", message,
        ...(route === "create" ? { name: "iris", profileId: profile.id, title: "review" }
          : route.startsWith("parent") ? { parent: true } : { threadId: "child" }),
      },
    });
    return { message, requests, response };
  } finally {
    await controller.dispose();
  }
}

test("subagent disposal drains admitted requests and rejects new admission", async () => {
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new WorkbenchSubagentController({
    provider: () => { throw new Error("Profiles do not call providers."); }, onRelationshipCommitted: async () => {},
    identities: {
      resolve: async () => { throw new Error("Profiles do not resolve thread identities."); },
      knownThread: () => { throw new Error("Profiles do not resolve thread identities."); },
    },
    publicThreadId: async () => { throw new Error("Profiles do not publish thread identities."); },
    profileStore: {
      read: async () => { entered(); await gate; return { profiles: [] }; },
      mutate: async () => { throw new Error("unexpected mutation"); },
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    subagentStore: {
      getOwned: async () => null, getOwnedMany: async () => [], list: async () => ({ nextCursor: null, subagents: [] }),
      remove: async () => {}, replace: async () => {}, reserve: async record => ({ ...record, directSubagentIndex: 0 }),
    },
  });
  try {
    const request = controller.handleRequest({ id: 1, method: "workbench/subagent/profiles", params: { cwd: "C:/repo" } });
    await reading;
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    const rejected = await controller.handleRequest({ id: 2, method: "workbench/subagent/profiles", params: { cwd: "C:/repo" } });
    assert.match(rejected.error?.message ?? "", /draining/);
    assert.equal(disposed, false);
    release();
    assert.equal((await request).error, undefined);
    await disposal;
  } finally {
    release();
    await controller.dispose();
  }
});

for (const harness of ["codex", "another-provider"] as const) {
  for (const route of ["create", "child-active", "child-idle", "parent-active", "parent-idle"] as const) {
    test(`${harness} ${route} messages retain sender authority and questionnaire ordering`, async () => {
      const { message, requests, response } = await exercise(route, harness);
      assert.equal(response.error, undefined);
      const deliveries = requests.filter((request) => request.method === "messageAgent");
      assert.equal(deliveries.length, 1);
      const delivery = deliveries[0]!;
      const params = delivery.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
      assert.deepEqual(params.message, {
        message, senderName: route.startsWith("parent") ? "iris" : "parent agent", senderThreadId: route.startsWith("parent") ? "child" : "parent",
      });
      const questionnaireIndex = requests.findIndex((request) => request.method === "respond");
      if (route === "child-active") assert.ok(questionnaireIndex > requests.indexOf(delivery));
      else assert.equal(questionnaireIndex, -1);
    });
  }
}

test("failed agent admission does not release a waiting child questionnaire", async () => {
  const { requests, response } = await exercise("child-active", "codex", true);
  assert.match(response.error?.message ?? "", /delivery rejected/u);
  assert.equal(requests.some(({ method }) => method === "respond"), false);
});

test("subagent operations use canonical destinations and sender identity", async () => {
  for (const route of ["create", "child-idle"] as const) {
    const { requests, response } = await exercise(route, "codex", false, true);
    assert.equal(response.error, undefined);
    const delivery = requests.find(({ method }) => method === "messageAgent")!;
    const params = delivery.params as Parameters<WorkbenchProviderThreads["messageAgent"]>[0];
    assert.equal(params.threadId, "public-child");
    assert.equal(params.context?.subagentName, "iris");
    assert.equal(params.message.senderThreadId, "public-parent");
  }
});
