/*
 * Exports: none. Tests protect message transport through the subagent owner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { TurnStartParams } from "workbench-shared/codex/generated/app-server/v2/TurnStartParams";
import type { WorkbenchComposerProfile, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import { readWorkbenchAgentMessageInput, readWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
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

function thread(id: string, active: boolean): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id, modelProvider: "openai", name: null, parentThreadId: null,
    model: null, projectId: null, reasoningEffort: null, path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null,
    sessionId: "session", source: "appServer", status: active ? { activeFlags: [], type: "active" } : { type: "idle" }, threadSource: null,
    turns: [{
      completedAt: active ? null : 2, durationMs: null, error: null, id: `turn-${id}`, items: [], itemsView: "full",
      startedAt: 1, status: active ? "inProgress" : "completed",
    }], updatedAt: 2,
  };
}

type Route = "create" | "child-active" | "child-idle" | "parent-active" | "parent-idle";

async function exercise(route: Route, harness: WorkbenchHarness, rejectDelivery = false, nativePort = false) {
  const requests: JsonRpcRequest[] = [];
  const identities = new Map(["parent", "child"].map(name => {
    const record = {
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(nativePort ? `public-${name}` : name),
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
  const provider = {
      connect: async () => {},
      close() {},
      async sendRequest<T>(request: JsonRpcRequest) {
        requests.push(request);
        const params = request.params as Record<string, unknown>;
        if (request.workbenchHarness !== harness) return { id: 1, error: { code: -32000, message: "not this harness" } };
        if (rejectDelivery && (request.method === "turn/start" || request.method === "turn/steer")) {
          return { id: 1, error: { code: -32000, message: "delivery rejected" } };
        }
        let result: object = {};
        switch (request.method) {
          case "thread/read": result = { thread: thread(String(params.threadId), route.endsWith("active")) }; break;
          case "thread/start": result = { thread: thread("child", false) }; break;
          case "questionnaire/list": result = { data: route === "child-active" ? [{
            requestKey: "question", threadId: "child", turnId: "turn-child",
            request: { id: "question", title: "review", summary: "", submitLabel: "send", questions: [{
              id: "choice", header: "", question: "continue?", options: [], allowOther: true, isSecret: false,
            }] },
          }] : [] }; break;
        }
        return { id: 1, result: result as T };
      },
    };
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    identities: { resolve: async ({ threadId }) => knownThread(threadId), knownThread },
    publicThreadId: async threadId => knownThread(threadId).threadId,
    createHarnessClient: () => {
      assert.equal(nativePort, false, "Internal provider work must not connect through the public socket.");
      return provider;
    },
    ...(nativePort ? {
      requestNativeHarness: (providerHarness: WorkbenchHarness, request: JsonRpcRequest) => {
        const params = request.params as Record<string, unknown> | undefined;
        return provider.sendRequest<object>({
          ...request, workbenchHarness: providerHarness,
          ...(typeof params?.threadId === "string"
            ? { params: { ...params, threadId: knownThread(params.threadId).bindings[0].nativeThreadId } }
            : {}),
        });
      },
    } : {}),
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
    bridgeUrl: "ws://unused", onRelationshipCommitted: async () => {},
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

for (const harness of ["codex", "copilot"] as const) {
  for (const route of ["create", "child-active", "child-idle", "parent-active", "parent-idle"] as const) {
    test(`${harness} ${route} messages retain sender authority and questionnaire ordering`, async () => {
      const { message, requests, response } = await exercise(route, harness);
      assert.equal(response.error, undefined);
      const deliveries = requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer");
      assert.equal(deliveries.length, 1);
      const delivery = deliveries[0]!;
      const params = delivery.params as TurnStartParams;
      const attributed = harness === "codex"
        ? typeof params.toolOutput?.output === "string" ? readWorkbenchAgentMessageText(params.toolOutput.output) : null
        : readWorkbenchAgentMessageInput(params.input);
      assert.deepEqual(attributed, {
        message, senderName: route.startsWith("parent") ? "iris" : "parent agent", senderThreadId: route.startsWith("parent") ? "child" : "parent",
      });
      if (harness === "codex") {
        assert.equal(delivery.method, "turn/start");
        assert.deepEqual(params.input, []);
      } else {
        assert.equal(delivery.method, route.endsWith("active") ? "turn/steer" : "turn/start");
        assert.equal(params.toolOutput, undefined);
      }
      const questionnaireIndex = requests.findIndex((request) => request.method === "questionnaire/respond");
      if (route === "child-active") assert.ok(questionnaireIndex > requests.indexOf(delivery));
      else assert.equal(questionnaireIndex, -1);
    });
  }
}

test("failed native agent admission does not release a waiting child questionnaire", async () => {
  const { requests, response } = await exercise("child-active", "codex", true);
  assert.match(response.error?.message ?? "", /delivery rejected/u);
  assert.equal(requests.some(({ method }) => method === "questionnaire/respond"), false);
});

test("the native subagent port keeps native destinations and canonical prompt/sender context", async () => {
  for (const route of ["create", "child-idle"] as const) {
    const { requests, response } = await exercise(route, "codex", false, true);
    assert.equal(response.error, undefined);
    const delivery = requests.find(({ method }) => method === "turn/start")!;
    const params = delivery.params as TurnStartParams;
    assert.equal(params.threadId, "native-child");
    assert.equal((delivery.workbenchPromptContext as { threadId: string }).threadId, "public-child");
    const sender = readWorkbenchAgentMessageText(params.toolOutput!.output as string);
    assert.equal(sender?.senderThreadId, "public-parent");
  }
});
