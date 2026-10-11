/*
 * No exports. Protect thread-owner projection from reading a detached presentation database, owner lookups shared across back-to-back commands, and lookup cost staying linear in observed threads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";

test("thread ownership waits through a presentation handoff and reprojects on resume", () => {
  const listeners = new Set<() => void>();
  // A daemon claims the thread, so resolving it needs presentation.
  const source = {
    id: "daemon",
    observe: (query: { threadId: string }) => ({
      getSnapshot: () => ({ phase: "current", failure: null, value: { kind: "threadIdentity", identity: { threadId: query.threadId, projectId: "project" } } }),
      release: () => {},
    }),
  };
  const sources = {
    all: () => [source],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as WorkbenchDaemonSources;
  const snapshot: PresentationSnapshot = {
    revision: 0, daemons: [], projects: [], locations: [], defaults: [], drafts: [],
    folders: [], members: [], divergences: [], sourceMappings: [],
  };
  let paused = false;
  let databaseOpen = true;
  let reads = 0;
  const presentation = {
    read: () => {
      if (!databaseOpen) throw new Error("Presentation database is not ready.");
      reads++;
      return snapshot;
    },
    subscribe: () => () => {},
  } as unknown as WorkbenchPresentationController;
  const owner = new WorkbenchWorkspaceThreads({
    sources, presentation, warn: () => {}, canProject: () => !paused,
  });
  owner.start();
  const observation = owner.observe(ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000001"), () => {});
  assert.equal(reads, 1);
  paused = true;
  databaseOpen = false;
  assert.doesNotThrow(() => { for (const listener of listeners) listener(); });
  assert.equal(reads, 1);
  databaseOpen = true;
  paused = false;
  owner.resumeProjection();
  assert.equal(reads, 2);
  observation.release();
  owner.dispose();
});

test("back-to-back thread commands share one daemon owner lookup until it idles out", () => {
  const observed: string[] = [];
  const released: string[] = [];
  const timers: Array<{ run(): void; cleared: boolean }> = [];
  const source = {
    id: "daemon",
    observe: (query: { threadId: string }) => {
      observed.push(query.threadId);
      return { getSnapshot: () => ({ phase: "pending", failure: null, value: null }), release: () => released.push(query.threadId) };
    },
  };
  const sources = { all: () => [source], subscribe: () => () => {} } as unknown as WorkbenchDaemonSources;
  const presentation = { read: () => ({ locations: [], members: [], drafts: [] }), subscribe: () => () => {} } as unknown as WorkbenchPresentationController;
  const owner = new WorkbenchWorkspaceThreads({
    sources, presentation, warn: () => {},
    schedule: run => {
      const timer = { run, cleared: false };
      timers.push(timer);
      return () => { timer.cleared = true; };
    },
  });
  const threadId = ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000002");
  for (let command = 0; command < 5; command += 1) owner.observe(threadId, () => {}).release();
  assert.deepEqual(observed, [threadId]);
  assert.deepEqual(released, []);
  // Only the latest idle timer stays armed; firing it retires the lookup.
  timers.filter(timer => !timer.cleared).forEach(timer => timer.run());
  assert.deepEqual(released, [threadId]);
  owner.observe(threadId, () => {}).release();
  assert.deepEqual(observed, [threadId, threadId]);
  owner.dispose();
  assert.deepEqual(released, [threadId, threadId]);
});

test("owner lookups stay linear as displays observe many threads", () => {
  let snapshotReads = 0;
  let presentationReads = 0;
  const identityChanged = new Map<string, () => void>();
  const source = {
    id: "daemon",
    observe: (query: { threadId: string }, listener: () => void) => {
      identityChanged.set(query.threadId, listener);
      const fact = { phase: "current", failure: null, value: { kind: "threadIdentity", identity: { threadId: query.threadId, projectId: "project" } } };
      return { getSnapshot: () => { snapshotReads++; return fact; }, release: () => {} };
    },
  };
  const sources = { all: () => [source], subscribe: () => () => {} } as unknown as WorkbenchDaemonSources;
  const presentation = {
    read: () => { presentationReads++; return { locations: [], members: [], drafts: [] }; },
    subscribe: () => () => {},
  } as unknown as WorkbenchPresentationController;
  const owner = new WorkbenchWorkspaceThreads({ sources, presentation, warn: () => {}, schedule: () => () => {} });
  const ids = Array.from({ length: 200 }, (_, index) =>
    ThreadReferenceSchema.parse(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
  for (const id of ids.slice(0, 100)) owner.observe(id, () => {});
  snapshotReads = 0;
  presentationReads = 0;
  // A second page re-observes the held threads and adds as many new ones.
  for (const id of ids) owner.observe(id, () => {});
  assert.ok(snapshotReads <= ids.length * 3, `${snapshotReads} snapshot reads for ${ids.length} observes`);
  assert.ok(presentationReads <= ids.length * 3, `${presentationReads} presentation reads for ${ids.length} observes`);
  snapshotReads = 0;
  identityChanged.get(ids[0]!)!();
  assert.ok(snapshotReads <= 3, `one thread's identity change read ${snapshotReads} snapshots`);
  owner.dispose();
});
