/* Exports: none. Protect WB action ownership and accepted-message settlement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchThreadActionController, { type WorkbenchThreadActionOwners } from "./WorkbenchThreadActionController";
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
      latestTurn: unused, admitTurn: unused,
      history: { questionnaires: unused, steers: unused, browse: unused },
      create: unused, list: unused, read: unused, page: unused,
      submit: async input => { messages.push(input); return { kind: "steered", turnId: "wb-turn", ...(providerWarning ? { warning: providerWarning } : {}) }; },
      rename: unused, compact: unused,
      interrupt: async (threadId, turnId) => {
        stopOrder.push("interrupt");
        if (interruptFailure) throw new Error("interruption failed");
        stops.push({ threadId, turnId });
      },
      materialize: unused,
    },
    configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
  };
  const owners: WorkbenchThreadActionOwners = {
    providers: { get: key => { assert.equal(key, "codex"); return provider; } },
    projects: { resolveProjectById: unused },
    identities: { resolveTurn: unused, resolve: async () => ({
      projectId, projectRoot: "C:/project", threadId,
      bindings: [{
        harness: "codex", nativeLocation: "C:/project",
        nativeThreadId: NativeThreadIdSchema.parse("native-thread"), pending: false, turnIndex: 0,
      }],
    }) },
    profiles: { captureCreationProfile: unused },
    state: {
      acceptProviderIntent: async (_project, _harness, acceptedThread, acceptedTurn) => {
        assert.equal(acceptedThread, threadId);
        assert.equal(acceptedTurn, "wb-turn");
        if (settlementFailure) throw new Error("state persistence unavailable");
        return unused();
      },
      getCanonicalThreadEntry: async () => null,
      handleRequest: async (connectionId, request) => {
        connections.push(connectionId);
        mutations.push(request);
        stopOrder.push("mutation");
        return titleFailure
          ? { error: { code: "invalidProjectObservation", message: "The connection does not observe this project." } }
          : { result: { ok: true } };
      },
    },
    warn: message => warnings.push(message),
  };
  return {
    controller: new WorkbenchThreadActionController(owners), messages, connections, warnings, stops, mutations, stopOrder,
    failInterrupt: () => { interruptFailure = true; },
    failSettlement: () => { settlementFailure = true; },
    failTitle: () => { titleFailure = true; },
  };
}

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
  assert.deepEqual(f.stopOrder, ["interrupt", "mutation"]);
});

test("failed interruption preserves the pending questionnaire", async () => {
  const f = fixture();
  f.failInterrupt();
  await assert.rejects(f.controller.handle("thread/stop", {
    threadId: "wb-thread", turnId: "wb-turn", intent: "stop", requestKey: "seen-question",
  }), /interruption failed/);
  assert.deepEqual(f.mutations, []);
});
