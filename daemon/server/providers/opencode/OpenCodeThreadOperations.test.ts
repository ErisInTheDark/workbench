/*
 * No production exports. Tests protect OpenCode admission intent and complete canonical message pagination.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import OpenCodeThreadOperations from "./OpenCodeThreadOperations";

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
    signal?: AbortSignal;
  } = {},
) {
  return new OpenCodeThreadOperations({
    acquire: async () => client as never,
    observe: lifecycle.observe ?? (async () => undefined),
    identities: {
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
    } as never,
    projects: {
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
      refresh: async () => undefined,
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
    reader: {} as never,
    signal: lifecycle.signal ?? new AbortController().signal,
  });
}

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
  const owner = operations({
    session: { create: async () => session },
  }, {
    record: async () => ({ threadId, latestTurnId: null }),
  }, {
    installCreatedProfile: async (...input: object[]) => { installed.push(input); },
  });
  Object.assign(owner, {
    page: async () => ({ thread }),
  });

  assert.equal(await owner.create({
    cwd: "C:/repo",
    profile,
    projectRoots: ["C:/repo"],
  }), thread);
  assert.deepEqual(installed, [["opencode", thread, profile]]);
});

test("fails a public read when no OpenCode binding exists", async () => {
  const owner = new OpenCodeThreadOperations({
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

test("materialises every canonical message page in ascending order", async () => {
  const requests: object[] = [];
  let recorded: string[] = [];
  const owner = operations({
    session: { get: async () => session },
    message: {
      list: async (input: { cursor?: string }) => {
        requests.push(input);
        return input.cursor
          ? { data: [{ id: "assistant", type: "assistant", agent: "agent", model: { id: "m", providerID: "p" }, content: [], time: { created: 2, completed: 3 } }], cursor: {} }
          : { data: [{ id: "user", type: "user", text: "hello", time: { created: 1 } }], cursor: { next: "second" } };
      },
    },
  }, {
    record: async (_session: object, messages: Array<{ id: string }>) => {
      recorded = messages.map(message => message.id);
      return { threadId, latestTurnId: turnId };
    },
  });

  await owner.syncNative(nativeThreadId);
  assert.deepEqual(requests, [
    { sessionID: nativeThreadId, limit: 100, order: "asc" },
    { sessionID: nativeThreadId, limit: 100, cursor: "second" },
  ]);
  assert.deepEqual(recorded, ["user", "assistant"]);
});

test("submits a steer once with native steer delivery", async () => {
  const prompts: object[] = [];
  const steerObservations: object[] = [];
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
    recordSteer: async (entry: object) => { steerObservations.push(entry); },
  });

  const result = await owner.submit({
    threadId,
    clientMessageId: "00000000-0000-4000-8000-000000000010",
    input: [{ type: "text", text: "please continue", text_elements: [] }],
    intent: "steer",
    expectedTurnId: turnId,
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
  assert.deepEqual((await owner.history.steers(threadId)).map(entry => ({
    clientUserMessageId: entry.clientUserMessageId,
    status: entry.status,
  })), [{
    clientUserMessageId: "00000000-0000-4000-8000-000000000010",
    status: "pending",
  }]);
});

test("admits a root turn directly without rereading provider history", async () => {
  const recorded: Array<{ session: object; messages: object[] }> = [];
  const owner = operations({
    session: {
      get: async () => session,
      prompt: async () => ({
        id: "inbox",
        sessionID: nativeThreadId,
        time: { created: 3 },
        type: "user",
        payload: { text: "hello" },
        delivery: "queue",
      }),
    },
  }, {
    record: async (nativeSession: object, messages: object[]) => {
      recorded.push({ session: nativeSession, messages });
      return { threadId, latestTurnId: turnId };
    },
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
    intent: "steer",
    expectedTurnId: turnId,
  }), /selected model is unavailable/u);
  assert.deepEqual(steerObservations.map(entry => entry.status), ["pending", "failed"]);
  assert.deepEqual(await owner.history.steers(threadId), []);
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
