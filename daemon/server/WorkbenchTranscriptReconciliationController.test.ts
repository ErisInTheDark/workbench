/* No production exports. Protect bounded demand, freshness, change reporting and recovery retirement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchTranscriptReconciliationController, { type WorkbenchTranscriptReconciliationOptions } from "./WorkbenchTranscriptReconciliationController";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

function identityPorts(turns: WorkbenchTranscriptSnapshot["turns"] = []): Pick<WorkbenchTranscriptReconciliationOptions, "identities" | "transcripts" | "isThreadObserved"> {
  return {
    isThreadObserved: () => true,
    identities: { resolve: async input => ({
      threadId: WorkbenchThreadIdSchema.parse(input.threadId), projectId: ProjectIdSchema.parse("project"), projectRoot: "/repo",
      bindings: [{ harness: "opencode", nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native"), pending: false, turnIndex: 2 }],
    }) },
    transcripts: { catalog: async () => ({ turns } as WorkbenchTranscriptSnapshot) },
  };
}

test("opening coalesces expired-turn recovery, newest first, stopping after the last observer leaves", async () => {
  const turns = ["old", "kept", "new"].map((id, turn_index) => ({
    id, thread_id: "thread", identity_origin: "workbench" as const, turn_index, harness_id: "codex",
    native_location: "/repo", native_thread_id: "native", native_turn_id: `native-${id}`,
    state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }));
  const ports = identityPorts(turns);
  const expired = new Set(["old", "new"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recovered: string[] = [];
  let observed = true;
  const owner = new WorkbenchTranscriptReconciliationController({
    ...ports,
    isThreadObserved: () => observed,
    transcripts: { catalog: async threadId => ({
      ...await ports.transcripts.catalog(threadId)!,
      expiredTurnPayloads: [...expired].map(turnId => ({ turnId, expiredAt: 5 })),
    } as WorkbenchTranscriptSnapshot) },
    readRecoveryGaps: async () => [],
    recover: async input => {
      assert.equal(input.explicit, true);
      assert.equal(input.target.mode, "exact");
      if (input.target.mode !== "exact") throw new Error("Expected exact recovery");
      recovered.push(input.target.turnId);
      if (input.target.turnId === "new") {
        entered.resolve();
        await release.promise;
        observed = false;
      }
      expired.delete(input.target.turnId);
      return { turnIds: [input.target.turnId], exhausted: false };
    },
    warn: assert.fail,
  });
  try {
    const first = owner.recoverObservedThread("thread");
    await entered.promise;
    const second = owner.recoverObservedThread("thread");
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(recovered, ["new"]);
    observed = true;
    await owner.recoverObservedThread("thread");
    assert.deepEqual(recovered, ["new", "old"]);
    await owner.recoverObservedThread("thread");
    assert.deepEqual(recovered, ["new", "old"]);
  } finally { await owner.dispose(); }
});

test("observed recovery leaves failed turns retryable without blocking other expired turns", async () => {
  const turns = ["good", "bad"].map((id, turn_index) => ({
    id, thread_id: "thread", identity_origin: "workbench" as const, turn_index, harness_id: "codex",
    native_location: "/repo", native_thread_id: "native", native_turn_id: id,
    state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }));
  const ports = identityPorts(turns);
  const recovered: string[] = [];
  const warnings: string[] = [];
  const expired = new Set(turns.map(turn => turn.id));
  let unavailable = true;
  const owner = new WorkbenchTranscriptReconciliationController({
    ...ports,
    transcripts: { catalog: async threadId => ({
      ...await ports.transcripts.catalog(threadId)!,
      expiredTurnPayloads: [...expired].map(turnId => ({ turnId, expiredAt: 5 })),
    } as WorkbenchTranscriptSnapshot) },
    readRecoveryGaps: async () => [],
    recover: async input => {
      if (input.target.mode !== "exact") throw new Error("Expected exact recovery");
      recovered.push(input.target.turnId);
      if (input.target.turnId === "bad" && unavailable) throw new Error("provider history unavailable");
      expired.delete(input.target.turnId);
      return { turnIds: [input.target.turnId], exhausted: false };
    },
    warn: message => warnings.push(message),
  });
  try {
    await owner.recoverObservedThread("thread");
    assert.deepEqual(recovered, ["bad", "good"]);
    assert.equal(warnings.length, 1);
    unavailable = false;
    await owner.recoverObservedThread("thread");
    assert.deepEqual(recovered, ["bad", "good", "bad"]);
  } finally { await owner.dispose(); }
});

test("leaving while observed recovery waits behind another thread prevents its provider read", async () => {
  const turn = {
    id: "turn", thread_id: "thread", identity_origin: "workbench" as const, turn_index: 0, harness_id: "codex",
    native_location: "/repo", native_thread_id: "native", native_turn_id: "native-turn",
    state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  };
  const ports = identityPorts([turn]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observed = true;
  const recovered: string[] = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...ports,
    isThreadObserved: () => observed,
    transcripts: { catalog: async threadId => ({
      ...await ports.transcripts.catalog(threadId)!,
      expiredTurnPayloads: [{ turnId: turn.id, expiredAt: 5 }],
    } as WorkbenchTranscriptSnapshot) },
    readRecoveryGaps: async threadId => {
      if (threadId === "thread") observed = false;
      return [];
    },
    recover: async input => {
      recovered.push(input.threadId);
      entered.resolve();
      await release.promise;
      return { turnIds: [turn.id], exhausted: false };
    },
    warn: assert.fail,
  });
  try {
    const blocking = owner.reconcile({ threadId: "other", target: { mode: "latest" }, refresh: false });
    await entered.promise;
    const opening = owner.recoverObservedThread("thread");
    release.resolve();
    await Promise.all([blocking, opening]);
    assert.deepEqual(recovered, ["other"]);
  } finally { await owner.dispose(); }
});

test("duplicate demands share one window while independent windows wait without fetching bodies", async () => {
  const first = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(),
    readRecoveryGaps: async () => [],
    recover: async () => {
      calls++;
      entered.resolve();
      await first.promise;
      return { turnIds: ["turn"], exhausted: false };
    },
    warn: assert.fail,
  });
  const latest = { threadId: "thread", target: { mode: "latest" as const }, refresh: false };
  const a = owner.reconcile(latest);
  const b = owner.reconcile(latest);
  const c = owner.reconcile({ ...latest, threadId: "other" });
  await entered.promise;
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve();
  await Promise.all([a, b, c]);
  assert.equal(calls, 2);
  await owner.dispose();
});

test("refresh arriving during native recovery gets a successor with a fresh gap snapshot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const snapshots: string[][] = [];
  let gaps = ["before"];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(),
    readRecoveryGaps: async () => gaps.map(id => ({ id, turnIds: [] })),
    recover: async input => {
      snapshots.push(input.gapIds);
      if (snapshots.length === 1) { entered.resolve(); await release.promise; }
      return { turnIds: ["turn"], exhausted: false };
    },
    warn: assert.fail,
  });
  const input = { threadId: "thread", target: { mode: "latest" as const }, refresh: false };
  const first = owner.reconcile(input);
  await entered.promise;
  gaps = ["before", "during"];
  const later = owner.reconcile({ ...input, refresh: true });
  const duplicate = owner.reconcile({ ...input, refresh: true });
  release.resolve();
  await Promise.all([first, later, duplicate]);
  assert.deepEqual(snapshots, [["before"], ["before", "during"]]);
  await owner.dispose();
});

test("failed windows retain useful bounded diagnostics and do not strand queued work", async () => {
  const warnings: string[] = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(),
    readRecoveryGaps: async () => [],
    recover: async input => {
      if (input.threadId === "failed") throw new Error("retained boundary omitted\nBearer private-credential " + "x".repeat(2_000));
      return { turnIds: ["saved"], exhausted: true };
    },
    warn: message => warnings.push(message),
  });
  const input = { threadId: "failed", target: { mode: "latest" as const }, refresh: false };
  const failure = assert.rejects(owner.reconcile(input), /boundary omitted/);
  const next = owner.reconcile({ ...input, threadId: "healthy" });
  await failure;
  assert.deepEqual(await next, { turnIds: ["saved"], exhausted: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /boundary omitted/);
  assert.doesNotMatch(warnings[0]!, /private-credential|[\r\n]/);
  assert.ok(warnings[0]!.length < 1_000);
  await owner.dispose();
});

for (const observed of [false, true]) {
test(`retirement drains ${observed ? "observed restoration" : "manual recovery"} and rejects queued demands`, async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const ports = identityPorts([{
    id: "turn", thread_id: "active", identity_origin: "workbench", turn_index: 0, harness_id: "codex",
    native_location: "/repo", native_thread_id: "native", native_turn_id: "native-turn", state: "completed",
    created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }]);
  const owner = new WorkbenchTranscriptReconciliationController({
    ...ports,
    transcripts: { catalog: async threadId => ({
      ...await ports.transcripts.catalog(threadId)!,
      expiredTurnPayloads: [{ turnId: "turn", expiredAt: 5 }],
    } as WorkbenchTranscriptSnapshot) },
    readRecoveryGaps: async () => [],
    recover: async (_input, signal) => {
      calls++;
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      signal.throwIfAborted();
      return { turnIds: [], exhausted: false };
    },
    warn: assert.fail,
  });
  const input = { threadId: "active", target: { mode: "latest" as const }, refresh: false };
  const active = observed ? owner.recoverObservedThread(input.threadId) : assert.rejects(owner.reconcile(input), /retired/);
  await entered.promise;
  const queued = assert.rejects(owner.reconcile({ ...input, threadId: "queued" }), /retired/);
  await owner.dispose();
  await Promise.all([active, queued]);
  assert.equal(owner.hasPendingWork(), false);
  assert.equal(calls, 1);
  await assert.rejects(owner.reconcile(input), /retired/);
});
}

test("a window reports changed only when a transcript commit for its own thread lands during recovery", async () => {
  const listeners = new Set<(threadIds: readonly string[]) => void>();
  let commit: readonly string[] = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(), readRecoveryGaps: async () => [],
    subscribeSettled: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    recover: async () => {
      for (const listener of listeners) listener(commit);
      return { turnIds: ["turn"], exhausted: false };
    },
    warn: assert.fail,
  });
  const latest = { threadId: "thread", target: { mode: "latest" as const }, refresh: false };
  try {
    assert.equal((await owner.reconcile(latest)).changed, false);
    commit = ["other"];
    assert.equal((await owner.reconcile(latest)).changed, false);
    commit = ["thread"];
    assert.equal((await owner.reconcile(latest)).changed, true);
  } finally { await owner.dispose(); }
  assert.equal(listeners.size, 0);
});

test("opening a thread re-reads each open-gap anchor once, and a failing re-read never rejects healing", async () => {
  const turns = ["anchored", "failing"].map((id, index) => ({
    id, thread_id: "thread", identity_origin: "workbench" as const,
    turn_index: index, harness_id: "codex", native_location: "/repo", native_thread_id: "native",
    native_turn_id: `native-${id}`, state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }));
  const recovered: string[] = [];
  const settled = Promise.withResolvers<void>();
  const warnings: string[] = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(turns),
    readRecoveryGaps: async () => [
      { id: "first", turnIds: ["anchored", "failing"] },
      { id: "second", turnIds: ["anchored"] },
    ],
    recover: async input => {
      assert.ok(input.target.mode === "exact");
      recovered.push(input.target.turnId);
      if (recovered.length === 2) settled.resolve();
      if (input.target.turnId === "failing") throw new Error("rollout unavailable");
      return { turnIds: [input.target.turnId], exhausted: false };
    },
    warn: message => warnings.push(message),
  });
  try {
    await owner.healCaptureGaps("thread");
    await settled.promise;
    await owner.healCaptureGaps("thread");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(recovered.sort(), ["anchored", "failing"], "each anchored turn is re-read once per lifetime");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /exact failed: rollout unavailable/);
  } finally { await owner.dispose(); }
});

test("an explicit demand never rides along with a routine window for the same turn", async () => {
  const turns = [{
    id: "turn", thread_id: "thread", identity_origin: "workbench" as const, turn_index: 0, harness_id: "codex",
    native_location: "/repo", native_thread_id: "native", native_turn_id: "native-turn", state: "completed" as const,
    created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const explicit: Array<true | undefined> = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(turns), readRecoveryGaps: async () => [],
    recover: async input => {
      explicit.push(input.explicit);
      entered.resolve();
      await release.promise;
      return { turnIds: ["turn"], exhausted: false };
    },
    warn: assert.fail,
  });
  try {
    const exact = { threadId: "thread", target: { mode: "exact" as const, turnId: "turn" }, refresh: false };
    const routine = owner.reconcile(exact);
    await entered.promise;
    const demanded = owner.reconcile({ ...exact, explicit: true });
    release.resolve();
    await Promise.all([routine, demanded]);
    assert.deepEqual(explicit, [undefined, true]);
  } finally { await owner.dispose(); }
});

test("previous recovery follows the preceding turn's native provenance across provider boundaries", async () => {
  const turns = ["codex", "opencode", "opencode"].map((harness, index) => ({
    id: `turn-${index}`, thread_id: "thread", identity_origin: "workbench" as const,
    turn_index: index, harness_id: harness, native_location: "/repo", native_thread_id: `${harness}-session`,
    native_turn_id: `native-${index}`, state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }));
  const recovered: Array<Parameters<WorkbenchTranscriptReconciliationOptions["recover"]>[0]> = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(turns), readRecoveryGaps: async () => [],
    recover: async input => { recovered.push(input); return { turnIds: [], exhausted: false }; },
    warn: assert.fail,
  });
  try {
    await owner.reconcile({ threadId: "thread", target: { mode: "previous", beforeTurnId: "turn-1" }, refresh: false });
    await owner.reconcile({ threadId: "thread", target: { mode: "previous", beforeTurnId: "turn-2" }, refresh: false });
    assert.deepEqual(recovered.map(({ harness, target }) => ({ harness, target })), [
      { harness: "codex", target: { mode: "exact", turnId: "turn-0" } },
      { harness: "opencode", target: { mode: "previous", beforeTurnId: "turn-2" } },
    ]);
    await assert.rejects(owner.reconcile({
      threadId: "thread", target: { mode: "exact", turnId: "foreign-turn" }, refresh: false,
    }), /does not belong/);
    assert.equal(recovered.length, 2);
  } finally { await owner.dispose(); }
});
