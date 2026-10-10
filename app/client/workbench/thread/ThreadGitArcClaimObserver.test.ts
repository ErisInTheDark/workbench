/*
 * Exports:
 * - No production exports; tests protect demanded claim-change reads, re-reads on claim changes, stale-read fencing and skipped running arcs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import ThreadGitArcClaimObserver, { type ThreadGitArcClaimObservation } from "./ThreadGitArcClaimObserver";

type Entry = Parameters<ThreadGitArcClaimObserver["sync"]>[0];

function entry({ claimedPaths = ["src/a.ts"], checkpoint = "a", working = false } = {}): Entry {
  return {
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: working ? { kind: "working", settled: false } : { kind: "completed", reason: "agentCompleted", settled: false },
    gitArc: {
      checkpointCommit: checkpoint.repeat(40), claimedPaths, intentDescription: "", intentName: "work",
      phase: claimedPaths.length ? "active" : "resolved", proposals: [], updatedAt: "2026-10-11",
    },
  } as unknown as Entry;
}

function harness() {
  const reads: Array<{ resolve: (value: { changeCount: number; hasUncommittedChanges: boolean }) => void; reject: (error: unknown) => void }> = [];
  let refresh: (() => void) | null = null;
  let changes = 0;
  const observer = new ThreadGitArcClaimObserver({
    compare: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
    subscribeRefresh: (listener) => { refresh = listener; return () => { refresh = null; }; },
    changed: () => { changes++; },
    isLive: () => true,
  });
  return { observer, reads, refresh: () => refresh?.(), get changes() { return changes; }, get subscribed() { return refresh !== null; } };
}

/** Lets settled reads run their continuations. */
async function settle() {
  for (let tick = 0; tick < 3; tick++) await Promise.resolve();
}

test("a demanded active claim reads its changes once and publishes them", async () => {
  const h = harness();
  h.observer.sync(entry(), "/repo");
  assert.equal(h.reads.length, 0, "nothing reads without demand");
  const release = h.observer.demand();
  h.observer.sync(entry(), "/repo");
  h.observer.sync(entry(), "/repo");
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.observer.claimChanges, { status: "loading" });
  h.reads[0]!.resolve({ changeCount: 2, hasUncommittedChanges: true });
  await settle();
  assert.deepEqual(h.observer.claimChanges, { changeCount: 2, hasUncommittedChanges: true, status: "loaded" });
  assert.equal(h.changes, 1);
  release();
  h.observer.sync(entry(), "/repo");
  assert.equal(h.observer.claimChanges, null);
  assert.equal(h.subscribed, false, "the refresh subscription ends with the last demand");
});

test("changed claims and refreshes re-read, keeping the loaded result while refreshing, and stale reads are dropped", async () => {
  const h = harness();
  h.observer.demand();
  h.observer.sync(entry(), "/repo");
  h.reads[0]!.resolve({ changeCount: 0, hasUncommittedChanges: false });
  await settle();

  h.observer.sync(entry({ claimedPaths: ["src/a.ts", "src/b.ts"] }), "/repo");
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.observer.claimChanges, { changeCount: 0, hasUncommittedChanges: false, refreshing: true, status: "loaded" });

  h.refresh();
  h.observer.sync(entry({ claimedPaths: ["src/a.ts", "src/b.ts"] }), "/repo");
  assert.equal(h.reads.length, 3);
  // The superseded read settles last and must not win.
  h.reads[2]!.resolve({ changeCount: 1, hasUncommittedChanges: false });
  await settle();
  h.reads[1]!.resolve({ changeCount: 9, hasUncommittedChanges: true });
  await settle();
  assert.deepEqual(h.observer.claimChanges, { changeCount: 1, hasUncommittedChanges: false, status: "loaded" });
});

test("running turns and resolved arcs read nothing, and failures publish the Git arc failure", async () => {
  const h = harness();
  h.observer.demand();
  h.observer.sync(entry({ working: true }), "/repo");
  h.observer.sync(entry({ claimedPaths: [] }), "/repo");
  assert.equal(h.reads.length, 0);
  assert.equal(h.observer.claimChanges, null);

  h.observer.sync(entry(), "/repo");
  h.reads[0]!.reject(new Error("compare broke"));
  await settle();
  // Read afresh: the earlier null assertion narrowed the property.
  const state: ThreadGitArcClaimObservation | null = h.observer.claimChanges as ThreadGitArcClaimObservation | null;
  assert.equal(state?.status, "failed");
  assert.match(state?.status === "failed" ? JSON.stringify(state.failure) : "", /compare broke/u);
});
