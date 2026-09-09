/*
 * No production exports. Tests protect fair usage/claim import, item failure isolation, coalesced starts, and disposal. Keywords: stats, import, lifecycle, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsImportController, { type WorkbenchStatsImportControllerOptions } from "./WorkbenchStatsImportController.ts";

function progress(
  state: WorkbenchStatsImportProgress["state"],
  usage = { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
  claims = { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
): WorkbenchStatsImportProgress {
  const processed = usage.processed + claims.processed;
  const total = usage.total + claims.total;
  return {
    claims,
    percent: total ? processed / total * 100 : 100,
    recentFailures: [],
    revision: 0,
    state,
    unsupportedClaimCheckpoints: 0,
    usage,
    version: 2,
  };
}

const discovery = {
  checkpointCommit: "a".repeat(40),
  checkpointRef: "refs/worktree/agents/codex/claim-thread/checkpoints/one",
  harness: "codex" as const,
  observedAt: 1,
  projectId: "project",
  repositoryRoot: "C:/project",
  rootId: "root",
  threadId: "claim-thread",
  workspaceRoot: "C:/project",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function lifecycleFixture() {
  const writes: string[] = [];
  const failures: unknown[] = [];
  const options: WorkbenchStatsImportControllerOptions = {
    claims: {
      reconcile: async () => undefined,
      discover: async () => ({ candidates: [], unsupported: 0 }),
      hydrate: async () => [],
    },
    database: {
      beginStatsImport: async () => { writes.push("begin"); return progress("running"); },
      repairStatsAttributions: async () => { writes.push("repair"); return {}; },
      addStatsClaimDiscoveries: async () => { writes.push("discoveries"); return progress("running"); },
      claimStatsClaimImport: async () => { writes.push("claim"); return null; },
      claimStatsUsageImport: async () => { writes.push("usage"); return null; },
      settleStatsClaimImport: async () => { writes.push("settle claim"); return progress("running"); },
      settleStatsUsageImport: async () => { writes.push("settle usage"); return progress("running"); },
      readStatsImportProgress: async () => progress("complete"),
    },
    harnesses: { hydrateUsage: async () => ({ state: "completed" }), listUsageHydrationHarnesses: () => ["codex"] },
    reportFailure: (error) => { failures.push(error); },
    yieldToEventLoop: async () => undefined,
  };
  return { options, writes, failures };
}

test("blocked reconciliation neither gates startup nor holds disposal", async () => {
  const { options, writes } = lifecycleFixture();
  const pending = deferred<void>();
  let cancellation: AbortSignal | undefined;
  options.claims.reconcile = async (signal) => { cancellation = signal; await pending.promise; };
  const controller = new WorkbenchStatsImportController(options);
  try {
    await controller.start();
    assert.ok(cancellation, "startup must launch claim reconciliation in its background run");
    const before = [...writes];
    await controller.dispose();
    assert.equal(cancellation.aborted, true);
    pending.resolve();
    await pending.promise;
    assert.deepEqual(writes, before);
  } finally {
    pending.resolve();
    await controller.dispose();
  }
});

for (const phase of ["discovery", "claim hydration", "usage hydration", "progress"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`retired ${phase} ${outcome} cannot write or publish`, async () => {
      const { options, writes, failures } = lifecycleFixture();
      const entered = deferred<void>();
      const pending = deferred<void>();
      const reported = deferred<void>();
      options.reportFailure = (error) => { failures.push(error); reported.resolve(); };
      let readFinished = Promise.resolve();
      const block = <T,>(value: T) => {
        const result = pending.promise.then(() => value);
        readFinished = result.then(() => undefined, () => undefined);
        entered.resolve();
        return result;
      };
      if (phase === "discovery") options.claims.discover = () => block({ candidates: [discovery], unsupported: 0 });
      if (phase === "claim hydration") {
        options.database.claimStatsClaimImport = async () => ({ ...discovery, kind: "claims" });
        options.claims.hydrate = () => block(["src/file.ts"]);
      }
      if (phase === "usage hydration") {
        options.database.claimStatsUsageImport = async () => ({ harness: "codex", kind: "usage", projectId: "project", threadId: "thread" });
        options.harnesses.hydrateUsage = () => block({ state: "completed" as const });
      }
      if (phase === "progress") options.database.readStatsImportProgress = () => block(progress("complete"));
      const controller = new WorkbenchStatsImportController(options);
      const published: WorkbenchStatsImportProgress[] = [];
      controller.subscribe((value) => { published.push(value); });
      await controller.start();
      await entered.promise;
      const before = [...writes];
      const beforeProgress = controller.getProgress();
      const disposal = controller.dispose();
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("retired source failed"));
      await disposal;
      await readFinished;
      if (outcome === "failure") await reported.promise;
      assert.deepEqual(writes, before);
      assert.equal(controller.getProgress(), beforeProgress);
      assert.equal(published.at(-1), beforeProgress);
      if (outcome === "failure") assert.equal(failures.length, 1);
    });
  }
}

test("reconciliation failure is reported without stopping history discovery", async () => {
  const { options, failures } = lifecycleFixture();
  const failure = new Error("claim reconciliation failed");
  let discovered = false;
  options.claims.reconcile = async () => { throw failure; };
  options.claims.discover = async () => { discovered = true; return { candidates: [], unsupported: 0 }; };
  const controller = new WorkbenchStatsImportController(options);
  const complete = deferred<void>();
  controller.subscribe((value) => { if (value.state === "complete") complete.resolve(); });
  await controller.start();
  await complete.promise;
  await controller.dispose();
  assert.equal(discovered, true);
  assert.ok(failures.includes(failure));
});

test("disposal preserves an issued database mutation but starts no follow-on work", async () => {
  const { options, writes } = lifecycleFixture();
  const entered = deferred<void>();
  const pending = deferred<WorkbenchStatsImportProgress>();
  options.database.addStatsClaimDiscoveries = async () => { entered.resolve(); return await pending.promise; };
  const controller = new WorkbenchStatsImportController(options);
  await controller.start();
  await entered.promise;
  const before = [...writes];
  let disposed = false;
  const disposal = controller.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  pending.resolve(progress("running"));
  await disposal;
  assert.deepEqual(writes, before);
});

test("importer alternates claim and usage work while isolating item failures", async () => {
  const order: string[] = [];
  let claimPending = true;
  let usagePending = true;
  let settledClaims = 0;
  let settledUsage = 0;
  const controller = new WorkbenchStatsImportController({
    claims: {
      discover: async () => ({ candidates: [discovery], unsupported: 7 }),
      hydrate: async () => {
        order.push("claims");
        return ["src/file.ts"];
      },
    },
    createRunId: () => "run",
    database: {
      addStatsClaimDiscoveries: async () => progress("running", { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }, { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }),
      beginStatsImport: async () => progress("running", { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }),
      claimStatsClaimImport: async () => {
        if (!claimPending) return null;
        claimPending = false;
        return { ...discovery, kind: "claims" };
      },
      claimStatsUsageImport: async () => {
        if (!usagePending) return null;
        usagePending = false;
        return { harness: "codex", kind: "usage", projectId: "project", threadId: "bad" };
      },
      readStatsImportProgress: async (state) => progress(
        state,
        { completed: 0, failed: settledUsage, processed: settledUsage, total: 1, unavailable: 0 },
        { completed: settledClaims, failed: 0, processed: settledClaims, total: 1, unavailable: 0 },
      ),
      repairStatsAttributions: async () => ({}),
      settleStatsClaimImport: async () => {
        settledClaims += 1;
        return progress("running");
      },
      settleStatsUsageImport: async (_runId, _candidate, settlement) => {
        assert.equal(settlement.state, "failed");
        settledUsage += 1;
        return progress("running");
      },
    },
    harnesses: {
      hydrateUsage: async () => {
        order.push("usage");
        throw new Error("broken");
      },
      listUsageHydrationHarnesses: () => ["codex"],
    },
    yieldToEventLoop: async () => undefined,
  });
  let resolveComplete!: (value: WorkbenchStatsImportProgress) => void;
  const complete = new Promise<WorkbenchStatsImportProgress>((resolve) => { resolveComplete = resolve; });
  controller.subscribe((value) => {
    if (value.state === "complete") resolveComplete(value);
  });
  await controller.start();
  const completed = await complete;
  await controller.dispose();
  assert.deepEqual(order, ["claims", "usage"]);
  assert.equal(completed.claims.completed, 1);
  assert.equal(completed.usage.failed, 1);
  assert.equal(completed.unsupportedClaimCheckpoints, 7);
});

test("importer coalesces concurrent starts into one background run", async () => {
  let beginCalls = 0;
  let releaseBegin!: () => void;
  const beginReleased = new Promise<void>((resolve) => { releaseBegin = resolve; });
  const controller = new WorkbenchStatsImportController({
    claims: { discover: async () => ({ candidates: [], unsupported: 0 }), hydrate: async () => [] },
    database: {
      addStatsClaimDiscoveries: async () => progress("running"),
      beginStatsImport: async () => {
        beginCalls += 1;
        await beginReleased;
        return progress("running");
      },
      claimStatsClaimImport: async () => null,
      claimStatsUsageImport: async () => null,
      readStatsImportProgress: async () => progress("complete"),
      repairStatsAttributions: async () => ({}),
      settleStatsClaimImport: async () => { throw new Error("Unexpected settlement."); },
      settleStatsUsageImport: async () => { throw new Error("Unexpected settlement."); },
    },
    harnesses: {
      hydrateUsage: async () => { throw new Error("Unexpected hydration."); },
      listUsageHydrationHarnesses: () => ["codex"],
    },
  });
  const first = controller.start();
  const second = controller.start();
  assert.equal(beginCalls, 1);
  releaseBegin();
  await Promise.all([first, second]);
  await controller.dispose();
  assert.equal(beginCalls, 1);
});
