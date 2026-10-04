/*
 * No exports. Protect thread-owner projection from reading a detached presentation database, and owner lookups shared across back-to-back commands.
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
  const sources = {
    all: () => [],
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
