/*
 * Exports: none. Tests protect subagent-controller request draining during reload.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as identitySchemas from "workbench-shared/workbench/identity";
import WorkbenchSubagentController from "./WorkbenchSubagentController";

const projectId = identitySchemas.ProjectIdSchema.parse("project");

test("subagent disposal drains admitted requests and rejects new admission", async () => {
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new WorkbenchSubagentController({
    provider: () => { throw new Error("Profiles do not call providers."); },
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
