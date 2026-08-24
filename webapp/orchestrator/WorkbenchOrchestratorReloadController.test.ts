/*
 * No production exports. Node tests protect reload claim barriers, useful batching, cancellation, and failure isolation. Keywords: reload, queue, claim, batch, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestratorReloadScope } from "../lib/types";
import WorkbenchOrchestratorReloadController, {
  type WorkbenchOrchestratorReloadControllerState,
  type WorkbenchReloadScopeClaim,
} from "./WorkbenchOrchestratorReloadController";

function deferred<TValue>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    reject = nextReject;
    resolve = nextResolve;
  });
  return { promise, reject, resolve };
}

function deadlineHarness() {
  const expired = deferred<void>();
  return {
    create: () => ({ cancel: () => undefined, expired: expired.promise }),
    expire: () => expired.resolve(),
  };
}

function claim(threadId: string, reloadScopes: OrchestratorReloadScope[], lifecycleKind: WorkbenchReloadScopeClaim["lifecycleKind"] = "working"): WorkbenchReloadScopeClaim {
  return { harness: "codex", lifecycleKind, reloadScopes, threadId };
}

function request(controller: WorkbenchOrchestratorReloadController, threadId: string, scopes: OrchestratorReloadScope[], signal = new AbortController().signal) {
  return controller.request({ cwd: "C:/workbench", harness: "codex", scopes, threadId }, signal);
}

test("a state handoff from the previous controller generation starts with no hard reload pending", () => {
  const legacyState = {
    activeBatch: null,
    eligibilityChanged: false,
    waiters: new Map(),
  } as unknown as WorkbenchOrchestratorReloadControllerState;
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => undefined,
    initialState: legacyState,
    listClaims: async () => [],
  });

  assert.equal(controller.isHardReloadPending(), false);
  assert.equal(legacyState.hardReloadPhase, "idle");
});

test("a useful partial batch satisfies all matching waiters and preserves the remaining request", async () => {
  let claims = [
    claim("one", ["next-dev", "orchestrator-logic"]),
    claim("two", ["next-dev"]),
    claim("logic-worker", ["orchestrator-logic"]),
  ];
  const batches: OrchestratorReloadScope[][] = [];
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async (scopes) => { batches.push(scopes); },
    listClaims: async () => claims,
  });

  let firstSettled = false;
  const first = request(controller, "one", ["next-dev", "orchestrator-logic"]).finally(() => { firstSettled = true; });
  await Promise.resolve();
  assert.deepEqual(batches, []);

  const second = request(controller, "two", ["next-dev"]);
  assert.deepEqual((await second).requestedScopes, ["next-dev"]);
  assert.deepEqual(batches, [["next-dev"]]);
  assert.equal(firstSettled, false);

  claims = claims.map((entry) => entry.threadId === "logic-worker" ? { ...entry, lifecycleKind: "completed" } : entry);
  controller.notifyEligibilityChanged();
  assert.deepEqual((await first).requestedScopes, ["next-dev", "orchestrator-logic"]);
  assert.deepEqual(batches, [["next-dev"], ["orchestrator-logic"]]);
});

test("needs-attention holders block while completed and stopped holders are safe", async () => {
  for (const lifecycleKind of ["needsAttention", "working"] as const) {
    let claims = [claim("caller", ["mcp"]), claim("holder", ["mcp"], lifecycleKind)];
    const executed = deferred<void>();
    const controller = new WorkbenchOrchestratorReloadController({
      executeBatch: async () => executed.resolve(),
      listClaims: async () => claims,
    });
    let settled = false;
    const pending = request(controller, "caller", ["mcp"]).finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    claims = claims.map((entry) => entry.threadId === "holder" ? { ...entry, lifecycleKind: "stopped" } : entry);
    controller.notifyEligibilityChanged();
    await executed.promise;
    assert.equal((await pending).state, "succeeded");
  }
});

test("cancellation removes a waiter without cancelling an executing batch", async () => {
  const executing = deferred<void>();
  const release = deferred<void>();
  const abort = new AbortController();
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => { executing.resolve(); await release.promise; },
    listClaims: async () => [claim("caller", ["codex-bridge"])],
  });
  const pending = request(controller, "caller", ["codex-bridge"], abort.signal);
  await executing.promise;
  abort.abort(new Error("caller left"));
  await assert.rejects(pending, /caller left/u);
  release.resolve();
});

test("a failed batch rejects dependent waiters but leaves disjoint work eligible", async () => {
  let claims = [
    claim("logic", ["orchestrator-logic"]),
    claim("next", ["next-dev"]),
    claim("next-worker", ["next-dev"]),
  ];
  const batches: OrchestratorReloadScope[][] = [];
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async (scopes) => {
      batches.push(scopes);
      if (scopes.includes("orchestrator-logic")) throw new Error("logic reload failed");
    },
    listClaims: async () => claims,
  });
  const failed = request(controller, "logic", ["orchestrator-logic"]);
  const disjoint = request(controller, "next", ["next-dev"]);
  await assert.rejects(failed, /logic reload failed/u);

  claims = claims.map((entry) => entry.threadId === "next-worker" ? { ...entry, lifecycleKind: "completed" } : entry);
  controller.notifyEligibilityChanged();
  assert.equal((await disjoint).state, "succeeded");
  assert.deepEqual(batches, [["orchestrator-logic"], ["next-dev"]]);
});

test("admission rejects scopes outside the caller active claim", async () => {
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => undefined,
    listClaims: async () => [claim("caller", ["mcp"])],
  });
  await assert.rejects(request(controller, "caller", ["next-dev"]), /does not claim/u);
  await assert.rejects(request(controller, "missing", ["mcp"]), /must own an active Git arc/u);
});

test("hard reload notifies every owner together and exits when they settle", async () => {
  const release = deferred<void>();
  const effects: string[] = [];
  let exits = 0;
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => undefined,
    hardReload: {
      exitProcess: () => { exits += 1; },
      notifications: () => [
        { name: "first", notify: () => { effects.push("first"); } },
        { name: "second", notify: async () => { effects.push("second"); await release.promise; } },
      ],
    },
    listClaims: async () => [],
  });

  controller.admitHardReload();
  const stopping = controller.beginHardReload();
  assert.deepEqual(effects, ["first", "second"]);
  assert.equal(exits, 0);
  release.resolve();
  await stopping;
  assert.equal(exits, 1);
});

test("hard reload deadline bypasses a stuck partial reload and forces exit", async () => {
  const executing = deferred<void>();
  const release = deferred<void>();
  const never = deferred<void>();
  const deadline = deadlineHarness();
  let exits = 0;
  const controller = new WorkbenchOrchestratorReloadController({
    executeBatch: async () => { executing.resolve(); await release.promise; },
    hardReload: {
      createDeadline: deadline.create,
      exitProcess: () => { exits += 1; },
      notifications: () => [{ name: "stuck", notify: async () => await never.promise }],
      timeoutMs: 5_000,
    },
    listClaims: async () => [claim("caller", ["mcp"])],
  });
  const partialReload = request(controller, "caller", ["mcp"]);
  await executing.promise;

  controller.admitHardReload();
  const stopping = controller.beginHardReload();
  await assert.rejects(partialReload, /hard reloading/u);
  deadline.expire();
  await stopping;
  assert.equal(exits, 1);
  release.resolve();
});
