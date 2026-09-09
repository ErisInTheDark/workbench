/*
 * Keywords: leases, reconnect, stale reply, thread isolation, readiness.
 * Exports: none. Tests protect the browser observation lifecycle through its socket port.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadObservationSnapshot } from "workbench-shared/workbench/thread/thread-state";
import ThreadObservationController from "./ThreadObservationController";

const target = { kind: "provider" as const, harness: "codex" as const, threadId: "thread" };

function fixture(releaseRequest: () => Promise<unknown> = async () => ({ accepted: true })) {
  const opens: Array<{ projectId: string; subscriptionId: string; target: typeof target; resolve: (value: object) => Promise<void>; reject: (error: Error) => Promise<void> }> = [];
  const releases: string[] = [];
  const owner = new ThreadObservationController({
    request: (method, params) => {
      if (method === "workbench/thread-state/release") {
        releases.push((params as { subscriptionId: string }).subscriptionId);
        return releaseRequest();
      }
      let resolve!: (value: object) => void;
      let reject!: (error: Error) => void;
      const response = new Promise<object>((accept, fail) => { resolve = accept; reject = fail; });
      opens.push({
        ...params as typeof opens[number],
        resolve: value => { resolve(value); return response.then(() => {}); },
        reject: error => { reject(error); return response.then(() => {}, () => {}); },
      });
      return response;
    },
  });
  function snapshot(index: number, revision: number, present = true): WorkbenchThreadObservationSnapshot {
    const open = opens[index]!;
    return {
      projectId: open.projectId, subscriptionId: open.subscriptionId, target: open.target,
      entries: present ? [{
        activityAt: 1, title: "Thread", entryKind: "thread", identity: { harness: "codex", threadId: open.target.threadId },
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      }] : [],
      revision, version: 1, updateKind: "threadObservation", freshness: "fresh", error: null,
    };
  }
  return { owner, opens, releases, snapshot };
}

test("root and child consumers share a subscription until the final lease releases", async () => {
  const { owner, opens, releases, snapshot } = fixture();
  let changes = 0;
  const root = owner.acquire("project", target, () => changes++);
  const child = owner.acquire("project", { ...target, kind: "subagent", parentThreadId: target.threadId, threadId: "child" });
  assert.equal(opens.length, 1);
  assert.equal(root.key, child.key);
  assert.equal(owner.getSnapshot(root.key).status, "loading");
  await opens[0]!.resolve({ observation: snapshot(0, 1) });
  assert.equal(owner.getSnapshot(root.key).status, "ready");
  assert.ok(changes > 0);
  root.release();
  assert.equal(releases.length, 0);
  child.release();
  child.release();
  assert.equal(releases.length, 1);
  assert.equal(owner.getSnapshot(root.key).status, "idle");
  owner.dispose();
});

test("a child on another provider opens its real family and shares the root lease", async () => {
  const { owner, opens } = fixture();
  const childTarget = { kind: "subagent" as const, harness: "opencode" as const, parentThreadId: "thread", threadId: "child" };
  const child = owner.acquire("project", childTarget);
  const root = owner.acquire("project", target);
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0]?.target, childTarget);
  assert.equal(child.key, root.key);
  owner.dispose();
});

test("an absent family is restored by connection recovery", async () => {
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: snapshot(0, 1, false) });
  assert.equal(owner.getSnapshot(lease.key).status, "absent");
  owner.reset();
  assert.equal(opens.length, 2);
  await opens[1]!.resolve({ observation: snapshot(1, 2) });
  assert.equal(owner.getSnapshot(lease.key).status, "ready");
  owner.dispose();
});

test("reconnecting retains mounted content but withholds readiness until the new subscription answers", async () => {
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: snapshot(0, 9) });
  const content = owner.getSnapshot(lease.key).observation;
  owner.disconnect();
  assert.equal(owner.getSnapshot(lease.key).status, "loading");
  assert.equal(owner.getSnapshot(lease.key).observation, content);
  owner.reset();
  assert.equal(owner.getSnapshot(lease.key).observation, content);
  await opens[1]!.resolve({ observation: snapshot(1, 1) });
  assert.equal(owner.getSnapshot(lease.key).status, "ready");
  assert.equal(owner.getSnapshot(lease.key).observation?.revision, 1);
  owner.dispose();
});

test("newer pushes beat bootstrap and other projects do not invalidate a consumer snapshot", async () => {
  const { owner, opens, snapshot } = fixture();
  const first = owner.acquire("first", target);
  const second = owner.acquire("second", target);
  assert.equal(opens.length, 2);
  owner.accept(snapshot(0, 3));
  const stable = owner.getSnapshot(first.key);
  await opens[0]!.resolve({ observation: snapshot(0, 1) });
  await opens[1]!.resolve({ observation: snapshot(1, 2) });
  assert.equal(owner.getSnapshot(first.key), stable);
  assert.equal(owner.getSnapshot(second.key).observation?.revision, 2);
  owner.dispose();
});

test("disconnect and reset replace tokens only for retained leases and ignore old replies", async () => {
  const { owner, opens, snapshot } = fixture();
  const retained = owner.acquire("project", target);
  const closed = owner.acquire("other", target);
  assert.equal(opens.length, 2);
  closed.release();
  owner.disconnect();
  assert.equal(owner.getSnapshot(retained.key).status, "loading");
  owner.reset();
  assert.equal(opens.length, 3);
  assert.notEqual(opens[0]!.subscriptionId, opens[2]!.subscriptionId);
  await opens[0]!.resolve({ observation: snapshot(0, 90) });
  await opens[1]!.resolve({ observation: snapshot(1, 90) });
  owner.accept(snapshot(0, 91));
  await opens[2]!.resolve({ observation: snapshot(2, 1, false) });
  assert.equal(owner.getSnapshot(retained.key).status, "absent");
  assert.equal(owner.getSnapshot(closed.key).status, "idle");
  owner.dispose();
});

test("failed bootstrap waits for connection recovery and disposal fences its replacement", async t => {
  t.mock.method(console, "warn", () => {});
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  assert.equal(opens.length, 1);
  await opens[0]!.reject(new Error("unsupported operation"));
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  assert.equal(opens.length, 1);
  owner.reset();
  assert.equal(opens.length, 2);
  owner.dispose();
  await opens[1]!.resolve({ observation: snapshot(1, 1) });
  assert.equal(owner.getSnapshot(lease.key).status, "idle");
  assert.equal(owner.getObservations().length, 0);
});

test("a mismatched reply cannot install a different project's state", async t => {
  t.mock.method(console, "warn", () => {});
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  assert.equal(opens.length, 1);
  await opens[0]!.resolve({ observation: { ...snapshot(0, 1), projectId: "other" } });
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  assert.equal(owner.getObservations().length, 0);
  owner.dispose();
});

test("connection recovery releases a failed subscription before replacing it", async () => {
  const { owner, opens, releases, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: { ...snapshot(0, 1), freshness: "partial", error: "Provider state unavailable." } });
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  owner.reset();
  assert.deepEqual(releases, [opens[0]!.subscriptionId]);
  assert.equal(opens.length, 2);
  owner.dispose();
});

test("invalid live state is reported and makes the matching observation unavailable", async t => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: snapshot(0, 1) });
  owner.accept({ ...snapshot(0, 2), entries: "invalid" });
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  owner.dispose();
});

test("release failures surface while connected but socket closure owns cleanup after disconnect", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  for (const disconnect of [false, true]) {
    let fail!: (error: Error) => void;
    const release = new Promise<unknown>((_resolve, reject) => { fail = reject; });
    const { owner, opens, snapshot } = fixture(() => release);
    const lease = owner.acquire("project", target);
    await opens[0]!.resolve({ observation: snapshot(0, 1) });
    lease.release();
    if (disconnect) owner.disconnect();
    fail(new Error("connection closed"));
    await release.catch(() => {});
    owner.dispose();
  }
  assert.equal(warnings.mock.callCount(), 1);
});
