/*
 * No production exports. Tests protect user-owned reload selection, dirt advancement, handoff, and hard-reload lifecycle. Keywords: reload, dirt, user, handoff, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestratorReloadScope } from "workbench-shared/types";
import type { OrchestratorReloadScopeDescriptor } from "workbench-shared/workbench/orchestrator-reload";
import WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const catalog: OrchestratorReloadScopeDescriptor[] = [
  { access: "agent", description: "Core", scope: "server:core", safeAll: true },
  { access: "agent", description: "MCP", scope: "server:mcp", safeAll: true },
  { access: "cli", description: "Codex harness", destructive: true, scope: "harness:codex", safeAll: false },
  { access: "operator", description: "Process", destructive: true, scope: "server:process", safeAll: false },
];

function dirtStub(options: {
  dirty?: Array<{ destructive: boolean; scope: OrchestratorReloadScope }>;
  events?: string[];
  listeners?: Set<() => void>;
}) {
  const events = options.events ?? [];
  return {
    beginReload: (scopes: readonly OrchestratorReloadScope[]) => events.push(`begin:${scopes.join(",")}`),
    completeReload: async (scopes: readonly OrchestratorReloadScope[]) => { events.push(`complete:${scopes.join(",")}`); },
    failReload: (error: unknown) => events.push(`fail:${error instanceof Error ? error.message : String(error)}`),
    getCatalog: () => catalog,
    getSnapshot: () => ({ dirtyScopes: options.dirty ?? [], error: null, pendingScopes: [] }),
    resumeAfterFailedReload: () => events.push("resume"),
    subscribe: (listener: () => void) => {
      options.listeners?.add(listener);
      return () => options.listeners?.delete(listener);
    },
  } as unknown as WorkbenchReloadDirtController;
}

test("all selects live dirt while destructive scopes require unsafe or an explicit selection", () => {
  const controller = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({ dirty: [
      { destructive: false, scope: "server:core" },
      { destructive: true, scope: "harness:codex" },
    ] }),
    executeBatch: async () => undefined,
  });

  assert.deepEqual(controller.resolveSelections({ all: true }, "cli"), ["server:core"]);
  assert.deepEqual(controller.resolveSelections({ all: true, unsafe: true }, "cli"), ["server:core", "harness:codex"]);
  assert.deepEqual(controller.resolveSelections({ scopes: ["harness:codex"] }, "cli"), ["harness:codex"]);
  assert.deepEqual(controller.resolveSelections({ all: true, scopes: ["server:process"] }, "operator"), ["server:process"]);
  assert.deepEqual(new WorkbenchOrchestratorReloadController({ dirt: dirtStub({}), executeBatch: async () => undefined }).resolveSelections({ all: true }, "cli"), []);
});

test("successful and failed user reloads advance dirt through one lifecycle owner", async () => {
  const events: string[] = [];
  const controller = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({ events }),
    executeBatch: async (scopes) => {
      events.push(`execute:${scopes.join(",")}`);
      if (scopes.includes("server:mcp")) throw new Error("reload failed");
    },
  });

  await controller.executeUnmanaged(["server:core"]);
  assert.deepEqual(events, ["begin:server:core", "execute:server:core", "complete:server:core"]);
  await assert.rejects(controller.executeUnmanaged(["server:mcp"]), /reload failed/u);
  assert.deepEqual(events.slice(-3), ["begin:server:mcp", "execute:server:mcp", "fail:reload failed"]);
});

test("exposes the dirt owner's snapshot and subscription without duplicating state", () => {
  const listeners = new Set<() => void>();
  const dirt = dirtStub({
    dirty: [{ destructive: false, scope: "server:core" }],
    listeners,
  });
  const controller = new WorkbenchOrchestratorReloadController({
    dirt,
    executeBatch: async () => undefined,
  });
  let notifications = 0;
  const unsubscribe = controller.subscribeReloadDirt(() => { notifications += 1; });
  assert.deepEqual(controller.getReloadDirtSnapshot(), dirt.getSnapshot());
  for (const listener of listeners) listener();
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("browser admission reserves a batch and starts only after its response is sent", async () => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({ events }),
    executeBatch: async (scopes) => { events.push(`execute:${scopes.join(",")}`); },
    now: () => 42,
    schedule: (callback) => { scheduled.push(callback); },
  });

  const admission = controller.admitUserReload({ scopes: ["server:core"] });
  assert.deepEqual(admission.response, {
    appliedScopes: [],
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: ["server:core"],
    requestedScopes: ["server:core"],
    startedAt: 42,
    state: "running",
  });
  assert.deepEqual(events, []);
  assert.throws(() => controller.admitUserReload({ scopes: ["server:mcp"] }), /already active/u);

  const completion = admission.start();
  assert.deepEqual(events, []);
  assert.equal(scheduled.length, 1);
  scheduled.shift()!();
  await completion;
  assert.deepEqual(events, ["begin:server:core", "execute:server:core", "complete:server:core"]);
});

test("failed browser response delivery cancels its reserved reload", async () => {
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({}),
    executeBatch: async () => undefined,
    schedule: (callback) => { scheduled.push(callback); },
  });
  const admission = controller.admitUserReload({ scopes: ["server:core"] });
  admission.cancel();
  await assert.rejects(admission.start(), /no longer active/u);
  assert.equal(scheduled.length, 0);
  controller.admitUserReload({ scopes: ["server:mcp"] }).cancel();
});

test("a replacement controller completes an in-flight batch without executing it twice", async () => {
  const events: string[] = [];
  const execution = deferred<void>();
  const first = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({ events }),
    executeBatch: async () => await execution.promise,
  });
  const pending = first.executeUnmanaged(["server:core"]);
  await Promise.resolve();
  const state = first.detachForReload();
  execution.resolve();
  await pending;
  assert.deepEqual(events, ["begin:server:core"]);

  const replacement = new WorkbenchOrchestratorReloadController({
    dirt: dirtStub({ events }), executeBatch: async () => { throw new Error("must not execute again"); }, initialState: state,
  });
  replacement.completeTransferredBatchIfPresent();
  await Promise.resolve();
  assert.deepEqual(events, ["begin:server:core", "complete:server:core"]);
});

test("hard reload notifies owners before one process exit", async () => {
  const events: string[] = [];
  const deadline = deferred<void>();
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => undefined,
    hardReload: {
      createDeadline: () => ({ cancel: () => events.push("cancel"), expired: deadline.promise }),
      exitProcess: () => events.push("exit"),
      notifications: () => [{ name: "server", notify: () => { events.push("notify"); } }],
    },
  });
  controller.admitHardReload();
  await controller.beginHardReload();
  assert.deepEqual(events, ["notify", "cancel", "exit"]);
});
