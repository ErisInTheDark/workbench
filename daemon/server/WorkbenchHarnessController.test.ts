/*
 * Exports:
 * - No production exports; Node tests protect harness registration, routing, and recovery.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { JsonRpcRequest } from "./bridge-types";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter } from "./WorkbenchHarnessController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread-one": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread-one"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "thread-one": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("workbench-thread-one"),
  },
};

function createAdapter(id: WorkbenchHarness, calls: string[] = []): WorkbenchHarnessAdapter {
  return {
    browse: {
      readThread: async (threadId) => {
        calls.push(`read:${id}:${threadId}`);
        return { thread: { id: threadId, turns: [] } } as never;
      },
      steerTurn: async (threadId, turnId) => {
        calls.push(`steer:${id}:${threadId}:${turnId}`);
        return "next-turn";
      },
    },
    browser: {
      handleBrowserMessage: async (request) => { calls.push(`browser:${id}:${request.method}`); },
    },
    id,
    internal: {
      request: async (request) => {
        calls.push(`request:${id}:${request.method}`);
        return { id: request.id ?? null, result: { id } };
      },
    },
    recovery: {
      kind: id === "copilot" ? "observe" : "turn",
      observeNotification: (notification) => { calls.push(`notification:${id}:${notification.method}`); },
      observeRequest: (request) => { calls.push(`recovery:${id}:${request.method}`); },
      ...(id === "copilot" ? {} : {
        resumeThread: async (threadId: string) => { calls.push(`resume:${id}:${threadId}`); },
      }),
    } as WorkbenchHarnessAdapter["recovery"],
    serverMethods: id === "codex" ? ["thread/read", "codex/only"] : ["thread/read"],
    ...(id === "codex" ? {
      usageHydration: async ({ threadId }) => {
        calls.push(`usage:${id}:${threadId}`);
        return { state: "completed" as const };
      },
    } : {}),
  };
}

function createController(calls: string[] = []) {
  return new WorkbenchHarnessController([
    createAdapter("codex", calls),
    createAdapter("copilot", calls),
    createAdapter("opencode", calls),
  ]);
}

test("future registered providers dispatch while unavailable identities cannot dispatch", async () => {
  const calls: string[] = [];
  const controller = new WorkbenchHarnessController([
    createAdapter("codex", calls),
    createAdapter("future-provider", calls),
  ]);
  await controller.handleBrowserMessage("future-provider", { id: 1, method: "thread/read" }, {} as never);
  assert.deepEqual(calls, ["recovery:future-provider:thread/read", "browser:future-provider:thread/read"]);
  calls.length = 0;
  await assert.rejects(async () => controller.handleBrowserMessage("not-installed", { id: 2, method: "thread/read" }, {} as never));
  assert.deepEqual(calls, []);
});

test("rejects invalid duplicate registrations and requires the default Codex adapter", () => {
  assert.throws(() => new WorkbenchHarnessController([createAdapter("copilot")]), /default Codex/u);
  assert.throws(() => new WorkbenchHarnessController([createAdapter("codex"), createAdapter("codex")]), /registered more than once/u);
  const duplicateMethods = createAdapter("codex");
  duplicateMethods.serverMethods = ["thread/read", "thread/read"];
  assert.throws(() => new WorkbenchHarnessController([duplicateMethods]), /duplicate values/u);
});

test("defaults absent browser routing to Codex and rejects explicit unknown harnesses", async () => {
  const calls: string[] = [];
  const controller = createController(calls);
  await controller.handleBrowserMessage(undefined, { id: 1, method: "thread/read" }, {} as never);
  assert.deepEqual(calls, ["recovery:codex:thread/read", "browser:codex:thread/read"]);
  assert.throws(() => controller.resolveHarness("haunted"), /Unknown Workbench harness/u);
  assert.deepEqual(controller.listHarnesses(), ["codex", "copilot", "opencode"]);
});

test("dispatches internal, server, Browse, and recovery work through the registered adapter", async () => {
  const calls: string[] = [];
  const controller = createController(calls);
  const request: JsonRpcRequest = { id: 2, method: "thread/read" };
  assert.deepEqual(await controller.requestServer("opencode", request), { id: 2, result: { id: "opencode" } });
  await controller.readThread("opencode", fixtureIdentityValues.NativeThreadId["thread-one"]);
  assert.equal(await controller.steerTurn("opencode", fixtureIdentityValues.NativeThreadId["thread-one"], fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn-one"), []), "next-turn");
  controller.observeNotification("opencode", { method: "turn/started", params: {} });
  await controller.resumeThread("opencode", fixtureIdentityValues.NativeThreadId["thread-one"]);
  await controller.request("copilot", { id: 3, method: "turn/start", params: { input: [], threadId: "thread-two" } });
  controller.observeNotification("copilot", { method: "turn/started", params: { threadId: "thread-two" } });
  await assert.rejects(() => controller.resumeThread("copilot", fixtureIdentityValues.NativeThreadId["thread-one"]), /unavailable for copilot/u);
  await assert.rejects(() => controller.requestServer("copilot", { method: "codex/only" }), /not allowed for copilot/u);
  assert.deepEqual(calls, [
    "recovery:opencode:thread/read",
    "request:opencode:thread/read",
    "read:opencode:thread-one",
    "steer:opencode:thread-one:turn-one",
    "notification:opencode:turn/started",
    "resume:opencode:thread-one",
    "recovery:copilot:turn/start",
    "request:copilot:turn/start",
    "notification:copilot:turn/started",
  ]);
});

test("database admission gates only newly started turns", async () => {
  const calls: string[] = [];
  const controller = new WorkbenchHarnessController([
    createAdapter("codex", calls),
  ], {
    admitTurnStart: () => {
      calls.push("database:admit");
      throw new Error("database unavailable");
    },
  });
  await controller.request("codex", { id: 1, method: "turn/steer" });
  await assert.rejects(controller.request("codex", { id: 2, method: "turn/start" }), /database unavailable/);
  await assert.rejects(
    controller.handleBrowserMessage("codex", { id: 3, method: "turn/start" }, {} as never),
    /database unavailable/,
  );
  assert.deepEqual(calls, [
    "recovery:codex:turn/steer",
    "request:codex:turn/steer",
    "database:admit",
    "database:admit",
  ]);
});

test("usage hydration dispatches only to adapters that own it", async () => {
  const calls: string[] = [];
  const controller = createController(calls);
  assert.deepEqual(controller.listUsageHydrationHarnesses(), ["codex"]);
  assert.deepEqual(await controller.hydrateUsage({
    harness: "codex", kind: "usage", projectId: "project", threadId: "thread",
  }), { state: "completed" });
  await assert.rejects(controller.hydrateUsage({
    harness: "copilot", kind: "usage", projectId: "project", threadId: "thread",
  }), /unavailable for copilot/u);
  assert.deepEqual(calls, ["usage:codex:thread"]);
});

test("durable-only identity resolution never probes the provider while default resolution can admit metadata", async () => {
  let admitted = false;
  let providerReads = 0;
  const identity = {
    bindings: [],
    projectId: fixtureIdentityValues.ProjectId["project"],
    projectRoot: "C:/project",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread-one"],
  };
  const controller = new WorkbenchHarnessController([
    createAdapter("codex"),
  ], {
    identities: {
      resolve: async () => admitted ? identity : null,
    } as never,
    providers: {
      get: () => ({
        threads: {
          read: async () => {
            providerReads += 1;
            admitted = true;
            return {} as never;
          },
        },
      }) as never,
    },
  });
  const lookup = {
    harness: "codex" as const,
    projectId: fixtureIdentityValues.ProjectId["project"],
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  };

  assert.equal(await controller.resolveThreadIdentity(lookup, { allowProviderAdmission: false }), null);
  assert.equal(providerReads, 0);
  assert.equal((await controller.resolveThreadIdentity(lookup))?.threadId, identity.threadId);
  assert.equal(providerReads, 1);
});
