/* Exports: none. Protect conjunctive idle compaction, message ordering, overlap and failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";
import type { ThreadPayload } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import WorkbenchThreadAutoCompactController, { type ThreadAutoCompactEvidence } from "./WorkbenchThreadAutoCompactController";

function fixture() {
  let settings = { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS };
  let evidence: ThreadAutoCompactEvidence | null = {
    activityAt: 0, contextTokens: 200_000,
  };
  let active = false;
  let nativeActive = false;
  let latest: Turn | null = { id: "turn", status: "interrupted" } as Turn;
  let compact = async () => { calls.push("compact"); };
  const calls: string[] = [];
  const owner = new WorkbenchThreadAutoCompactController({
    readSettings: async () => settings,
    readEvidence: async () => evidence,
    now: () => 30 * 60_000,
  });
  const provider = { threads: {
    read: async () => ({ status: active ? "active" : "idle" }) as ThreadPayload,
    latestTurn: async () => latest,
    isTurnLive: async () => active || nativeActive,
    compact: async () => compact(),
  } };
  return {
    owner, provider, calls,
    settings: (next: Partial<typeof settings>) => { settings = { ...settings, ...next }; },
    evidence: (next: ThreadAutoCompactEvidence | null) => { evidence = next; },
    active: () => { active = true; },
    nativeActive: () => { nativeActive = true; },
    latest: (status: Turn["status"] | null) => { latest = status === null ? null : { id: "turn", status } as Turn; },
    compact: (next: () => Promise<void>) => { compact = next; },
    admit: async () => { calls.push("admit"); active = true; return "started"; },
  };
}

test("inactive completed, failed and interrupted turns compact at both exact thresholds before admission", async () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const f = fixture();
    f.latest(status);
    assert.equal(await f.owner.run("thread", f.provider, f.admit), "started");
    assert.deepEqual(f.calls, ["compact", "admit"]);
    await f.owner.dispose();
  }
});

test("either unmet threshold, missing evidence or turn, disabled policy and live executions leave admission unchanged", async () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => f.settings({ enabled: false }),
    (f: ReturnType<typeof fixture>) => f.evidence(null),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 1, contextTokens: 200_000 }),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 0, contextTokens: 199_999 }),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 0, contextTokens: null }),
    (f: ReturnType<typeof fixture>) => f.latest(null),
    (f: ReturnType<typeof fixture>) => f.active(),
    (f: ReturnType<typeof fixture>) => f.nativeActive(),
  ]) {
    const f = fixture();
    configure(f);
    await f.owner.run("thread", f.provider, f.admit);
    assert.deepEqual(f.calls, ["admit"]);
    await f.owner.dispose();
  }
});

test("overlapping messages wait for compaction and the first admission, then recheck runtime truth", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  f.compact(async () => { f.calls.push("compact"); started.resolve(); await completion.promise; });
  const first = f.owner.run("thread", f.provider, f.admit);
  await Promise.race([started.promise, first.then(() => assert.fail("admission finished before compaction started"))]);
  const second = f.owner.run("thread", f.provider, f.admit);
  assert.deepEqual(f.calls, ["compact"]);
  completion.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, ["compact", "admit", "admit"]);
  await f.owner.dispose();
});

test("compaction failure rejects the message without starting a turn, and later admissions still work", async () => {
  const f = fixture();
  f.compact(async () => { throw new Error("compact failed"); });
  await assert.rejects(f.owner.run("thread", f.provider, f.admit), /compact failed/);
  assert.deepEqual(f.calls, []);
  f.settings({ enabled: false });
  await f.owner.run("thread", f.provider, f.admit);
  assert.deepEqual(f.calls, ["admit"]);
  await f.owner.dispose();
});

test("runtime drain rejects queued messages without admitting them after the earlier operation settles", async () => {
  const f = fixture();
  f.settings({ enabled: false });
  const admitted = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const first = f.owner.run("thread", f.provider, async () => {
    admitted.resolve();
    await settled.promise;
  });
  await admitted.promise;
  const next = f.owner.run("thread", f.provider, f.admit);
  const rejected = assert.rejects(next, /reloading/);
  assert.equal(f.owner.hasPendingWork(), true);
  f.owner.beginRuntimeDrain();
  settled.resolve();
  await first;
  await rejected;
  await f.owner.dispose();
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.hasPendingWork(), false);
});
