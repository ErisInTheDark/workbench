/*
 * Exports: none. Tests protect the browser observation lifecycle through its socket port.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadObservationSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import ThreadObservationController from "./ThreadObservationController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
  },
};

const target = { kind: "provider" as const, harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };

function fixture(releaseRequest: () => Promise<unknown> = async () => ({ accepted: true })) {
  const opens: Array<{ projectId: string; subscriptionId: string; target: typeof target; version: 2; resolve: (value: object) => Promise<void>; reject: (error: Error) => Promise<void> }> = [];
  const releases: string[] = [];
  const owner = new ThreadObservationController({
    release: async subscriptionId => {
      releases.push(subscriptionId);
      await releaseRequest();
    },
    observe: params => {
      let resolve!: (value: object) => void;
      let reject!: (error: Error) => void;
      const response = new Promise<object>((accept, fail) => { resolve = accept; reject = fail; });
      opens.push({
        ...params as typeof opens[number],
        version: 2,
        resolve: value => { resolve(value); return response.then(() => {}); },
        reject: error => { reject(error); return response.then(() => {}, () => {}); },
      });
      return response;
    },
  });
  function snapshot(index: number, revision: number, present = true): WorkbenchThreadObservationSnapshot {
    const open = opens[index]!;
    return {
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(open.projectId), subscriptionId: open.subscriptionId, target: open.target,
      entries: present ? [{
        activityAt: 1, title: "Thread", entryKind: "thread", identity: { harness: "codex", threadId: open.target.threadId },
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      }] : [],
      revision, version: open.version, updateKind: "threadObservation", freshness: "fresh", error: null,
    };
  }
  return { owner, opens, releases, snapshot };
}

test("root and child consumers share a subscription until the final lease releases", async () => {
  const { owner, opens, releases, snapshot } = fixture();
  let changes = 0;
  const root = owner.acquire("project", target, () => changes++);
  const child = owner.acquire("project", { ...target, kind: "subagent", parentThreadId: target.threadId, threadId: fixtureIdentityValues.WorkbenchThreadId["child"] });
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

test("an invalid observation target does not masquerade as an older protocol", async t => {
  t.mock.method(console, "warn", () => {});
  const { owner, opens } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.reject(new WorkbenchDaemonRequestError(
    "Invalid observation target", "invalidThreadStateMutation" as never,
  ));
  assert.equal(opens.length, 1);
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  owner.dispose();
});

test("a child on another provider opens its real family and shares the root lease", async () => {
  const { owner, opens } = fixture();
  const childTarget = { kind: "subagent" as const, harness: "opencode" as const, parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") };
  const child = owner.acquire("project", childTarget);
  const root = owner.acquire("project", target);
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0]?.target, childTarget);
  assert.equal(child.key, root.key);
  owner.dispose();
});

test("an absent family becomes available through pushed facts", async () => {
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: snapshot(0, 1, false) });
  assert.equal(owner.getSnapshot(lease.key).status, "absent");
  owner.accept(snapshot(0, 2));
  assert.equal(opens.length, 1);
  assert.equal(owner.getSnapshot(lease.key).status, "ready");
  owner.dispose();
});

test("stale workspace facts retain mounted content without opening another subscription", async () => {
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: snapshot(0, 9) });
  owner.accept({ ...snapshot(0, 10), freshness: "loading" });
  assert.equal(owner.getSnapshot(lease.key).status, "loading");
  assert.equal(owner.getSnapshot(lease.key).observation?.entries.length, 1);
  owner.accept(snapshot(0, 11));
  assert.equal(owner.getSnapshot(lease.key).status, "ready");
  assert.equal(opens.length, 1);
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

test("replacing a view ignores retired replies and leaves other released views closed", async () => {
  const { owner, opens, snapshot } = fixture();
  const retained = owner.acquire("project", target);
  const closed = owner.acquire("other", target);
  assert.equal(opens.length, 2);
  closed.release();
  retained.release();
  const replacement = owner.acquire("project", target);
  assert.equal(opens.length, 3);
  assert.notEqual(opens[0]!.subscriptionId, opens[2]!.subscriptionId);
  await opens[0]!.resolve({ observation: snapshot(0, 90) });
  await opens[1]!.resolve({ observation: snapshot(1, 90) });
  owner.accept(snapshot(0, 91));
  await opens[2]!.resolve({ observation: snapshot(2, 1, false) });
  assert.equal(owner.getSnapshot(replacement.key).status, "absent");
  assert.equal(owner.getSnapshot(closed.key).status, "idle");
  owner.dispose();
});

test("failed bootstrap waits for a new view lease and disposal fences its replacement", async t => {
  t.mock.method(console, "warn", () => {});
  const { owner, opens, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  assert.equal(opens.length, 1);
  await opens[0]!.reject(new Error("unsupported operation"));
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  assert.equal(opens.length, 1);
  lease.release();
  owner.acquire("project", target);
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
  await opens[0]!.resolve({ observation: { ...snapshot(0, 1), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other") } });
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  assert.equal(owner.getObservations().length, 0);
  owner.dispose();
});

test("a recovered publication clears a source failure without replacing its read interest", async () => {
  const { owner, opens, releases, snapshot } = fixture();
  const lease = owner.acquire("project", target);
  await opens[0]!.resolve({ observation: { ...snapshot(0, 1), freshness: "partial", error: "Provider state unavailable." } });
  assert.equal(owner.getSnapshot(lease.key).status, "failed");
  owner.accept(snapshot(0, 2));
  assert.deepEqual(releases, []);
  assert.equal(opens.length, 1);
  assert.equal(owner.getSnapshot(lease.key).status, "ready");
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

test("release failures surface rather than assuming ownership of a shared connection", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  {
    let fail!: (error: Error) => void;
    const release = new Promise<unknown>((_resolve, reject) => { fail = reject; });
    const { owner, opens, snapshot } = fixture(() => release);
    const lease = owner.acquire("project", target);
    await opens[0]!.resolve({ observation: snapshot(0, 1) });
    lease.release();
    fail(new Error("connection closed"));
    await release.catch(() => {});
    owner.dispose();
  }
  assert.equal(warnings.mock.callCount(), 1);
});
