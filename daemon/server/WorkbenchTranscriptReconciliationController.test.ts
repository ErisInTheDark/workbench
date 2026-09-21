/* No production exports. Protect bounded demand, freshness and recovery retirement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchTranscriptReconciliationController, { type WorkbenchTranscriptReconciliationOptions } from "./WorkbenchTranscriptReconciliationController";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

function identityPorts(turns: WorkbenchTranscriptSnapshot["turns"] = []): Pick<WorkbenchTranscriptReconciliationOptions, "identities" | "transcripts"> {
  return {
    identities: { resolve: async input => ({
      threadId: WorkbenchThreadIdSchema.parse(input.threadId), projectId: ProjectIdSchema.parse("project"), projectRoot: "/repo",
      bindings: [{ harness: "opencode", nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native"), pending: false, turnIndex: 2 }],
    }) },
    transcripts: { catalog: async () => ({ turns } as WorkbenchTranscriptSnapshot) },
  };
}

test("duplicate demands share one window while independent windows wait without fetching bodies", async () => {
  const first = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(),
    readGapIds: async () => [],
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
    readGapIds: async () => [...gaps],
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
    readGapIds: async () => [],
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

test("retirement aborts active native work, rejects queued demands and drains the owner", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(),
    readGapIds: async () => [],
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
  const active = assert.rejects(owner.reconcile(input), /retired/);
  await entered.promise;
  const queued = assert.rejects(owner.reconcile({ ...input, threadId: "queued" }), /retired/);
  await owner.dispose();
  await Promise.all([active, queued]);
  assert.equal(calls, 1);
  await assert.rejects(owner.reconcile(input), /retired/);
});

test("previous recovery follows the preceding turn's native provenance across provider boundaries", async () => {
  const turns = ["codex", "opencode", "opencode"].map((harness, index) => ({
    id: `turn-${index}`, thread_id: "thread", identity_origin: "workbench" as const,
    turn_index: index, harness_id: harness, native_location: "/repo", native_thread_id: `${harness}-session`,
    native_turn_id: `native-${index}`, state: "completed" as const, created_at: 1, started_at: 1, ended_at: 2, duration_ms: 1,
  }));
  const recovered: Array<Parameters<WorkbenchTranscriptReconciliationOptions["recover"]>[0]> = [];
  const owner = new WorkbenchTranscriptReconciliationController({
    ...identityPorts(turns), readGapIds: async () => [],
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
