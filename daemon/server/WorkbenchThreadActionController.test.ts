/* Exports: none. Protect WB action ownership, accepted-message settlement, orphaned stop settlement and undelivered steer resend/dismiss. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchThreadActionController, {
  WorkbenchThreadCreationNotDispatchedError, type WorkbenchThreadActionOwners,
} from "./WorkbenchThreadActionController";
import type WorkbenchProvider from "./WorkbenchProvider";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

function fixture(providerWarning?: string) {
  const unused = async (): Promise<never> => { throw new Error("Unexpected operation."); };
  const projectId = ProjectIdSchema.parse("project");
  const threadId = WorkbenchThreadIdSchema.parse("wb-thread");
  const messages: object[] = [];
  const connections: string[] = [];
  const warnings: string[] = [];
  const stops: Array<{ threadId: string; turnId: string }> = [];
  const mutations: object[] = [];
  const stopOrder: string[] = [];
  let interruptFailure = false;
  let settlementFailure = false;
  let titleFailure = false;
  const provider: WorkbenchProvider = {
    threads: {
      reconcile: unused, readLatest: unused, messageAgent: unused,
      latestTurn: unused, admitTurn: unused,
      history: { materialize: unused },
      create: unused, list: unused, read: unused,
      submit: async input => { messages.push(input); return { kind: "steered", turnId: "wb-turn", ...(providerWarning ? { warning: providerWarning } : {}) }; },
      rename: unused, compact: unused,
      interrupt: async (threadId, turnId) => {
        stopOrder.push("interrupt");
        if (interruptFailure) throw new Error("interruption failed");
        stops.push({ threadId, turnId });
      },
      isTurnLive: unused,
      materialize: unused,
    },
    configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
  };
  const recorded: object[] = [];
  const owners: WorkbenchThreadActionOwners = {
    approvals: { list: () => [] },
    reconciliation: { reconcile: unused },
    transcripts: { readPage: unused, history: unused },
    transcript: { record: async observations => { recorded.push(...observations); return undefined as never; } },
    settlement: { settleIfOrphaned: async () => { stopOrder.push("settle"); return false; } },
    providers: { get: key => { assert.equal(key, "codex"); return provider; } },
    projects: { resolveProjectById: unused },
    identities: { resolveTurn: unused, resolve: async () => ({
      projectId, projectRoot: "C:/project", threadId,
      bindings: [{
        harness: "codex", nativeLocation: "C:/project",
        nativeThreadId: NativeThreadIdSchema.parse("native-thread"), pending: false, turnIndex: 0,
      }],
    }) },
    profiles: { captureCreationProfile: unused, captureCreationProfileForProject: unused },
    skills: { read: unused, deactivate: unused },
    recordSkillActivations: async () => undefined,
    state: {
      acceptProviderIntent: async (_project, _harness, acceptedThread, acceptedTurn) => {
        assert.equal(acceptedThread, threadId);
        assert.equal(acceptedTurn, "wb-turn");
        if (settlementFailure) throw new Error("state persistence unavailable");
        return unused();
      },
      getCanonicalThreadEntry: async () => null,
      listPendingQuestionnaires: () => [],
      handleRequest: async (connectionId, request) => {
        connections.push(connectionId);
        mutations.push(request);
        stopOrder.push("mutation");
        return titleFailure
          ? { error: { code: "invalidProjectObservation", message: "The connection does not observe this project." } }
          : { result: { accepted: true, revision: 1 } };
      },
    },
    warn: message => warnings.push(message),
  };
  return {
    provider, owners,
    controller: new WorkbenchThreadActionController(owners), messages, connections, warnings, stops, mutations, stopOrder, recorded,
    failInterrupt: () => { interruptFailure = true; },
    failSettlement: () => { settlementFailure = true; },
    failTitle: () => { titleFailure = true; },
  };
}

test("provider deletion resolves aliases without mutating WB state and preserves failures", async () => {
  const f = fixture();
  const deleted: string[] = [];
  f.provider.threads.delete = async threadId => { deleted.push(threadId); };
  assert.deepEqual(await f.controller.handle("thread/provider/delete", { threadId: "native-thread" }), { ok: true });
  assert.deepEqual(deleted, ["wb-thread"]);
  assert.deepEqual(f.mutations, []);
  f.provider.threads.delete = async () => { throw new Error("provider refused deletion"); };
  await assert.rejects(f.controller.handle("thread/provider/delete", { threadId: "wb-thread" }), /provider refused deletion/);
  assert.deepEqual(f.mutations, []);
});

test("creation preparation failure is distinct from an uncertain provider failure", async () => {
  const f = fixture();
  const input = { projectId: "project", profile: { kind: "snapshot" as const,
    selection: { kind: "custom" as const, settings: {
      agentPath: null, agentSource: null, harness: "codex" as const, model: "test",
      reasoningEffort: null, serviceTier: null,
    } },
  } };
  const location = { rootPath: "C:/project", roots: ["C:/project"] };
  f.owners.projects.resolveProjectById = async () => { throw new Error("project unavailable"); };
  await assert.rejects(f.controller.createForLaunch(input, "launch", location), error =>
    error instanceof WorkbenchThreadCreationNotDispatchedError);
  f.owners.projects.resolveProjectById = async () => ({
    id: ProjectIdSchema.parse("project"), kind: "git", root: "C:/project",
    rootPath: "C:/project", roots: [{ id: "root", name: "project",
      root: "C:/project", rootPath: "C:/project", relativePath: "." }],
  });
  f.owners.profiles.captureCreationProfileForProject = async () => ({
    cwd: "C:/project",
    selection: { kind: "custom", settings: {
      agentPath: null, agentSource: null, harness: "codex", model: "test",
      reasoningEffort: null, serviceTier: null,
    } },
  }) as never;
  f.provider.threads.create = async () => { throw new Error("native response lost"); };
  await assert.rejects(f.controller.createForLaunch(input, "launch", location), error =>
    error instanceof Error && !(error instanceof WorkbenchThreadCreationNotDispatchedError)
    && error.message === "native response lost");
});

test("canonical page reads do not require an available provider", async () => {
  const f = fixture();
  const reads: string[] = [];
  const page = { nextCursor: null, questionnaireEntries: [], steerEntries: [], browseResultEntries: [], thread: {} };
  Object.assign(f.owners, {
    transcripts: {
      readPage: async (input: { threadId: string }) => {
        reads.push(input.threadId);
        return page;
      },
    },
  });
  f.owners.providers.get = () => { throw new Error("provider unavailable"); };
  const identity = await f.owners.identities.resolve({ threadId: WorkbenchThreadIdSchema.parse("wb-thread") });
  assert.ok(identity);
  f.owners.identities.resolve = async () => ({ ...identity, bindings: [
    ...identity.bindings,
    { harness: "opencode", nativeLocation: "C:/project", nativeThreadId: NativeThreadIdSchema.parse("other-native"), pending: false, turnIndex: 1 },
  ] });
  assert.equal(await f.controller.handle("thread/page/read", { threadId: "wb-thread", cursor: null }), page);
  assert.deepEqual(reads, ["wb-thread"]);
});

test("missing targets identify durable identity resolution and the requested thread", async () => {
  const f = fixture();
  f.owners.identities.resolve = async () => null;
  await assert.rejects(
    f.controller.handle("thread/goal/read", { threadId: "missing-thread" }),
    /durable Workbench identity.*missing-thread/iu,
  );
});

test("provider deletion rejects unsupported and ambiguous targets before any destructive call", async () => {
  const f = fixture();
  await assert.rejects(f.controller.handle("thread/provider/delete", { threadId: "wb-thread" }), /does not support/);
  const identity = await f.owners.identities.resolve({ threadId: WorkbenchThreadIdSchema.parse("wb-thread") });
  assert.ok(identity);
  f.owners.identities.resolve = async () => ({ ...identity, bindings: [...identity.bindings, ...identity.bindings] });
  f.provider.threads.delete = async () => assert.fail("Ambiguous deletion must not reach the provider");
  await assert.rejects(f.controller.handle("thread/provider/delete", { threadId: "wb-thread" }), /unambiguous/);
  assert.deepEqual(f.mutations, []);
});

test("accepted messages retain WB identity and are not resent when state settlement fails", async () => {
  const f = fixture();
  f.failSettlement();
  const result = await f.controller.handle("thread/message/submit", {
    threadId: "wb-thread", clientMessageId: "message", input: [{
      type: "text", text: "hello",
      text_elements: [{ byteRange: { start: 0, end: 5 }, placeholder: null }],
    }],
    intent: "continue",
  });
  assert.equal(result.kind, "steered");
  assert.ok(result.warning);
  assert.equal(f.messages.length, 1);
  assert.equal(f.warnings.length, 1);
  assert.ok("threadId" in f.messages[0]);
  assert.equal(f.messages[0].threadId, "wb-thread");
});

test("new-turn admission passes the first non-empty user text as display fallback", async () => {
  const f = fixture();
  const fallbacks: Array<string | undefined> = [];
  f.provider.threads.submit = async () => ({ kind: "started", turn: { id: "wb-turn" } as never });
  f.owners.state.acceptProviderIntent = async (_project, _harness, _threadId, _turnId, fallback?: string) => {
    fallbacks.push(fallback);
    return null;
  };
  const input = [
    { type: "text", text: "  ", text_elements: [] },
    { type: "text", text: "First user message", text_elements: [] },
  ];
  await f.controller.handle("thread/message/submit", {
    threadId: "wb-thread", clientMessageId: "launch:one", input, intent: "newTurn",
  });
  await f.controller.handle("thread/message/submit", {
    threadId: "wb-thread", clientMessageId: "steer", input, intent: "steer", expectedTurnId: "wb-turn",
  });
  assert.deepEqual(fallbacks, ["First user message", undefined]);
});

test("message admission ignores browser steer classification", async () => {
  const f = fixture();
  await f.controller.handle("thread/message/submit", {
    threadId: "wb-thread", clientMessageId: "message", input: [], intent: "steer", expectedTurnId: "stale-turn",
  });
  assert.deepEqual(f.messages, [{
    threadId: "wb-thread", clientMessageId: "message", input: [], intent: "continue",
  }]);
});

test("accepted provider warnings survive an additional state settlement failure", async () => {
  const f = fixture("Recorder needs repair.");
  f.failSettlement();
  const result = await f.controller.handle("thread/message/submit", {
    threadId: "wb-thread", clientMessageId: "message", input: [], intent: "continue",
  });
  assert.ok(result.warning?.includes("Recorder needs repair."));
  assert.ok(result.warning?.includes(f.warnings[0]));
  assert.equal(f.messages.length, 1);
});

test("dismissing a preserved questionnaire does not interrupt provider work", async () => {
  const f = fixture();
  await f.controller.handle("thread/stop", {
    threadId: "wb-thread", intent: "stop", requestKey: "preserved-question",
  });
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.stopOrder, ["mutation"]);
});

test("title actions preserve connection authorisation and propagate mutation rejection", async () => {
  const f = fixture();
  await f.controller.handle("thread/title/set", { threadId: "wb-thread", title: "new title" }, "observing-connection");
  assert.deepEqual(f.connections, ["observing-connection"]);
  f.failTitle();
  await assert.rejects(f.controller.handle("thread/title/set", { threadId: "wb-thread", title: "not saved" }, "other-connection"), /does not observe/);
  await assert.rejects(f.controller.handle("thread/title/set", { threadId: "wb-thread", title: "not saved" }), /observing connection/);
});

test("stop retains the caller's questionnaire identity instead of selecting a replacement", async () => {
  const f = fixture();
  await f.controller.handle("thread/stop", {
    threadId: "wb-thread", turnId: "wb-turn", intent: "stop", requestKey: "seen-question",
  });
  assert.deepEqual(f.stops, [{ threadId: "wb-thread", turnId: "wb-turn" }]);
  assert.equal(f.mutations.length, 1);
  assert.ok("requestKey" in f.mutations[0]);
  assert.equal(f.mutations[0].requestKey, "seen-question");
  assert.deepEqual(f.stopOrder, ["interrupt", "settle", "mutation"]);
});

function heldSteer(status: string) {
  return {
    itemId: "steer-item", entryKey: "steer-item", threadId: "wb-thread", turnId: "wb-turn", status,
    input: [{ type: "text", text: "use the DX language features", text_elements: [] }],
    attemptedAt: 1, resolvedAt: 2, requestId: null, canonicalItemId: null, clientUserMessageId: "old-client", error: null,
  };
}

function withSteer(f: ReturnType<typeof fixture>, status: string) {
  f.owners.transcripts.history = async () => ({ steerEntries: [heldSteer(status)] }) as never;
}

test("dismissing an undelivered steer records the user's final word, and held steers cannot be dismissed", async () => {
  const f = fixture();
  withSteer(f, "interrupted");
  assert.deepEqual(await f.controller.handle("thread/steer/dismiss", { threadId: "wb-thread", itemId: "steer-item" }), { ok: true });
  assert.equal(f.recorded.length, 1);
  assert.deepEqual((f.recorded[0] as { entry: { status: string }; publicItemId: string }).entry.status, "dismissed");
  assert.equal((f.recorded[0] as { publicItemId: string }).publicItemId, "steer-item");
  withSteer(f, "pending");
  await assert.rejects(f.controller.handle("thread/steer/dismiss", { threadId: "wb-thread", itemId: "steer-item" }), /undelivered/);
  assert.equal(f.recorded.length, 1);
});

test("resending submits the held input as a fresh message before retiring the undelivered copy", async () => {
  const f = fixture();
  f.owners.state.acceptProviderIntent = async () => null;
  withSteer(f, "failed");
  const result = await f.controller.handle("thread/steer/resend", { threadId: "wb-thread", itemId: "steer-item" });
  assert.equal(result.kind, "steered");
  assert.equal(f.messages.length, 1);
  const message = f.messages[0] as { intent: string; input: unknown; clientMessageId: string };
  assert.equal(message.intent, "continue");
  assert.deepEqual(message.input, heldSteer("failed").input);
  assert.notEqual(message.clientMessageId, "old-client");
  assert.equal((f.recorded[0] as { entry: { status: string } }).entry.status, "dismissed");

  const failed = fixture();
  withSteer(failed, "failed");
  failed.provider.threads.submit = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(failed.controller.handle("thread/steer/resend", { threadId: "wb-thread", itemId: "steer-item" }), /provider unavailable/);
  assert.deepEqual(failed.recorded, []);
});

test("failed interruption preserves the pending questionnaire", async () => {
  const f = fixture();
  f.failInterrupt();
  await assert.rejects(f.controller.handle("thread/stop", {
    threadId: "wb-thread", turnId: "wb-turn", intent: "stop", requestKey: "seen-question",
  }), /interruption failed/);
  assert.deepEqual(f.mutations, []);
});
