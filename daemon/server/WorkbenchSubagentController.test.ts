/*
 * Exports: none. Tests protect subagent-controller request draining during reload.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as identitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import WorkbenchSubagentController from "./WorkbenchSubagentController";

const projectId = identitySchemas.ProjectIdSchema.parse("project");

test("subagent disposal drains admitted requests and rejects new admission", async () => {
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new WorkbenchSubagentController({
    provider: () => { throw new Error("Profiles do not call providers."); },
    stopThread: async () => { throw new Error("Profiles do not stop threads."); },
    acceptIntent: async () => { throw new Error("Profiles do not message threads."); },
    onRelationshipCommitted: async () => {},
    identities: {
      resolve: async () => { throw new Error("Profiles do not resolve thread identities."); },
      knownThread: () => { throw new Error("Profiles do not resolve thread identities."); },
    },
    publicThreadId: async () => { throw new Error("Profiles do not publish thread identities."); },
    profileStore: {
      read: async () => { entered(); await gate; return { profiles: [] }; },
      mutate: async () => { throw new Error("unexpected mutation"); },
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: projectId, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    subagentStore: {
      getOwnedMany: async () => [],
      list: async () => ({ nextCursor: null, subagents: [] }),
      remove: async () => {},
      replace: async () => {},
      reserve: async record => ({ ...record, directSubagentIndex: 0 }),
    },
  });
  try {
    const request = controller.handleRequest({ id: 1, method: "workbench/subagent/profiles", params: { cwd: "C:/repo" } });
    await reading;
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    const rejected = await controller.handleRequest({ id: 2, method: "workbench/subagent/profiles", params: { cwd: "C:/repo" } });
    assert.match(rejected.error?.message ?? "", /draining/u);
    assert.equal(disposed, false);
    release();
    assert.equal((await request).error, undefined);
    await disposal;
  } finally {
    release();
    await controller.dispose();
  }
});

test("Git adoption names resolve only an unsettled unlocked direct child", async () => {
  const parentThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("parent");
  const childThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("child");
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1, updatedAt: 1, cwd: "C:/repo", directSubagentIndex: 0,
    harness: "codex", name: "mira", parentThreadId, projectId, threadId: childThreadId,
    profileId: "profile", profileName: "profile", title: "Child",
  };
  let settled = false;
  let pinned = false;
  const controller = new WorkbenchSubagentController({
    provider: () => { throw new Error("No provider turn is needed."); },
    stopThread: async () => { throw new Error("No thread stop is needed."); },
    acceptIntent: async () => { throw new Error("No thread message is needed."); },
    onRelationshipCommitted: async () => {},
    identities: {
      knownThread: (threadId: string) => ({ threadId }) as never,
      resolve: async () => null,
    },
    publicThreadId: async threadId => identitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    profileStore: {
      read: async () => ({ profiles: [] }),
      mutate: async () => { throw new Error("Unexpected profile mutation."); },
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: projectId, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    subagentStore: {
      getOwnedMany: async (parent, _project, ids) =>
        parent === parentThreadId && ids[0] === childThreadId ? [relationship] : null,
      list: async ({ parentThreadId: parent }: { parentThreadId?: string | null }) => ({
        nextCursor: null, subagents: parent === parentThreadId ? [relationship] : [],
      }),
      remove: async () => {}, replace: async () => {},
      reserve: async record => ({ ...record, directSubagentIndex: 0 }),
    },
    threadState: {
      getEntry: async () => ({ entryKind: "subagent", pinned, lifecycle: { settled } }) as never,
    } as never,
  });
  try {
    const select = (parent = parentThreadId) => controller.resolveGitArcPeer({
      cwd: "C:/repo", parentThreadId: parent, name: "mira",
    });
    assert.deepEqual(await select(), { harness: "codex", threadId: childThreadId });
    await assert.rejects(select(identitySchemas.WorkbenchThreadIdSchema.parse("other")), /not found|owned/i);
    settled = true;
    await assert.rejects(select(), /not found/i);
    settled = false;
    pinned = true;
    await assert.rejects(select(), /locked/i);
  } finally { await controller.dispose(); }
});
