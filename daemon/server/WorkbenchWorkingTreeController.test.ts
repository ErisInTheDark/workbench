/* No production exports. Protect directory/rename claims, scan failures and mutation claim fences. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkingTreeRepository } from "workbench-shared/workbench/git/working-tree-contracts";
import type { GitArcRegistryEntry } from "./lib/workbench/git/GitArcRegistry";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import WorkbenchWorkingTreeController from "./WorkbenchWorkingTreeController";

test("retained directory claims protect rename sources and reject mutations after a new claim", async () => {
  const git = new WorkbenchGitRepository(process.cwd());
  const snapshot: WorkingTreeRepository = {
    rootId: "root", label: "root", cwd: git.root, head: "a".repeat(40), tree: "b".repeat(40),
    branch: "main", message: "", amendReason: null, blockedReason: null, owners: [],
    files: [{
      path: "new.txt", oldPath: "src/old.txt", status: "R", baseBlob: "c".repeat(40), blob: "d".repeat(40),
      baseMode: "100644", mode: "100644", identity: "file", additions: 1, deletions: 1,
      binary: false, partial: false, ownerIds: [],
    }],
  };
  let claims: GitArcRegistryEntry[] = [];
  let inaccessible = false;
  let mutations = 0;
  const claim: GitArcRegistryEntry = {
    threadId: "owner", harness: "codex", checkpointCommit: "e".repeat(40), claimedPaths: ["src"],
    phase: "plan", intentName: "work", intentDescription: "", updatedAt: "",
    retainedArc: { checkpointCommit: "e".repeat(40), claimedPaths: ["src"], intentName: "work", intentDescription: "", phase: "active", proposalIds: [] },
  };
  const controller = new WorkbenchWorkingTreeController({
    resolveProject: async () => ({ roots: [
      { id: "root", name: "root", rootPath: git.root },
      ...(inaccessible ? [{ id: "inaccessible", name: "inaccessible", rootPath: "inaccessible" }] : []),
    ] }),
    resolveIdentity: async input => ({ threadId: input.threadId, nativeThreadId: input.threadId }),
    readOwner: async () => null,
    listClaims: async () => claims,
    openRepository: async cwd => {
      if (cwd === "inaccessible") throw new Error("access denied");
      return {
        git, read: async () => structuredClone(snapshot),
        diff: async () => ({ identity: "file", patch: "", unavailable: null }),
        preview: async () => ({ identity: "file", before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
        mutate: async (_snapshot, _request, verify) => {
          claims = [claim];
          await verify();
          mutations++;
          return { status: "complete", commit: null, stash: null, message: "", warnings: [] };
        },
      };
    },
    transitions: { read: async (_root, operation) => operation(), run: async (_root, operation) => operation() },
    warn: () => {},
  });
  await assert.rejects(controller.mutate({
    projectId: "project", rootId: "root", mode: "commit", expectedHead: snapshot.head, targetCommit: null,
    title: "work", description: "", selections: [{ path: "new.txt", identity: "file", lineIds: null }],
  }), /claimed/i);
  assert.equal(mutations, 0);
  const read = await controller.read("project");
  assert.deepEqual(read.repositories[0]!.files[0]!.ownerIds, ["owner"]);
  assert.equal(read.repositories[0]!.files.filter(file => !file.ownerIds.length).length, 0);
  inaccessible = true;
  const partial = await controller.read("project");
  assert.equal(partial.repositories.length, 1);
  assert.equal(partial.errors[0]?.rootId, "inaccessible");
  await assert.rejects(controller.diff({ projectId: "project", rootId: "outside", path: "new.txt", identity: "file" }), /root/i);
  await controller.dispose();
  await assert.rejects(controller.read("project"), /reload|disposed/i);
});

test("disposal rejects new work and drains an admitted mutation", async () => {
  const git = new WorkbenchGitRepository(process.cwd());
  let finish!: () => void;
  let entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const controller = new WorkbenchWorkingTreeController({
    resolveProject: async () => ({ roots: [{ id: "root", name: "root", rootPath: git.root }] }),
    resolveIdentity: async input => ({ threadId: input.threadId, nativeThreadId: input.threadId }),
    readOwner: async () => null,
    listClaims: async () => [],
    openRepository: async () => ({
      git,
      read: async () => ({
        rootId: "root", label: "root", cwd: git.root, head: "a".repeat(40), tree: "b".repeat(40),
        branch: "main", message: "", amendReason: null, blockedReason: null, files: [], owners: [],
      }),
      diff: async () => ({ identity: "", patch: "", unavailable: null }),
      preview: async () => ({ identity: "", before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
      mutate: async () => {
        const pending = new Promise<void>(resolve => { finish = resolve; });
        entered();
        await pending;
        return { status: "complete", commit: null, stash: null, message: "", warnings: [] };
      },
    }),
    transitions: { read: async (_root, operation) => operation(), run: async (_root, operation) => operation() },
  });
  const mutation = controller.mutate({
    projectId: "project", rootId: "root", mode: "amend", expectedHead: "a".repeat(40), targetCommit: "a".repeat(40),
    title: "message", description: "", selections: [],
  });
  await admitted;
  let disposed = false;
  const disposal = controller.dispose().then(() => { disposed = true; });
  await assert.rejects(controller.read("project"), /reloading/);
  assert.equal(disposed, false);
  finish();
  await Promise.all([mutation, disposal]);
  assert.equal(disposed, true);
});
