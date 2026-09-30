/*
 * No exports. Protect thread-owner projection from reading a detached presentation database.
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
