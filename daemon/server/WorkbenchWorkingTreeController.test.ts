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

test("content reuses the scan snapshot while mutations always read fresh and invalidate it", async () => {
  const git = new WorkbenchGitRepository(process.cwd());
  let scans = 0;
  let now = 0;
  const snapshot: WorkingTreeRepository = {
    rootId: "root", label: "root", cwd: git.root, head: "a".repeat(40), tree: "b".repeat(40),
    branch: "main", message: "", amendReason: null, blockedReason: null, owners: [],
    files: [{ path: "a", oldPath: null, identity: "version", status: "M", baseBlob: null, blob: null,
      mode: "100644", baseMode: "100644", partial: true, binary: false, additions: 1, deletions: 1, ownerIds: [] }],
  };
  const controller = new WorkbenchWorkingTreeController({
    now: () => now,
    resolveProject: async () => ({ roots: [{ id: "root", name: "root", rootPath: git.root }] }),
    resolveIdentity: async input => ({ threadId: input.threadId, nativeThreadId: input.threadId }),
    readOwner: async () => null,
    listClaims: async () => [],
    openRepository: async () => ({
      git, read: async () => { scans++; return structuredClone(snapshot); },
      diff: async () => ({ identity: "version", patch: "", unavailable: null }),
      preview: async () => ({ identity: "version", before: "", after: "", encoding: "text", mime: "text/plain", unavailable: null }),
      mutate: async () => { throw new Error("publication failed"); },
    }),
    transitions: { read: async (_root, operation) => operation(), run: async (_root, operation) => operation() },
    warn: () => {},
  });
  const request = { projectId: "project", rootId: "root", path: "a", identity: "version" };
  await controller.read("project");
  await controller.diff(request);
  await controller.preview(request);
  assert.equal(scans, 1);
  now = 5_000;
  await controller.diff(request);
  assert.equal(scans, 1);
  await assert.rejects(controller.mutate({
    projectId: "project", rootId: "root", mode: "commit", expectedHead: snapshot.head, targetCommit: null,
    title: "message", description: "", selections: [{ path: "a", identity: "version", lineIds: null }],
  }), /publication failed/);
  assert.equal(scans, 2);
  await controller.diff(request);
  assert.equal(scans, 3);
  await controller.dispose();
});

test("cached openings bypass in-flight scans, expire, and are invalidated across shared-root projects", async () => {
  const git = new WorkbenchGitRepository(process.cwd());
  let scans = 0;
  let now = 0;
  let deferred = false;
  let finish!: () => void;
  let entered!: () => void;
  const scanStarted = new Promise<void>(resolve => { entered = resolve; });
  const controller = new WorkbenchWorkingTreeController({
    now: () => now,
    resolveProject: async () => ({ roots: [{ id: "root", name: "root", rootPath: git.root }] }),
    resolveIdentity: async input => ({ threadId: input.threadId, nativeThreadId: input.threadId }),
    readOwner: async () => null, listClaims: async () => [],
    openRepository: async () => ({
      git,
      read: async () => {
        scans++;
        if (deferred) { entered(); await new Promise<void>(resolve => { finish = resolve; }); }
        return {
          rootId: "root", label: "root", cwd: git.root, head: "a".repeat(40), tree: "b".repeat(40),
          branch: "main", message: "", amendReason: null, blockedReason: null, owners: [],
          files: [{ path: "a", oldPath: null, identity: "version", status: "M" as const, baseBlob: null, blob: null,
            mode: "100644", baseMode: "100644", partial: true, binary: false, additions: 1, deletions: 1, ownerIds: [] }],
        };
      },
      diff: async () => ({ identity: "", patch: "", unavailable: null }),
      preview: async () => ({ identity: "", before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
      mutate: async () => { throw new Error("publication failed"); },
    }),
    transitions: { read: async (_root, operation) => operation(), run: async (_root, operation) => operation() },
    warn: () => {},
  });
  assert.notEqual((await controller.read("project", true)).cacheHit, true);
  assert.equal((await controller.read("project", true)).cacheHit, true);
  assert.equal(scans, 1);
  now = 5_001;
  await controller.diff({ projectId: "project", rootId: "root", path: "a", identity: "version" });
  assert.equal(scans, 1);
  deferred = true;
  const fresh = controller.read("project");
  await scanStarted;
  assert.equal((await controller.read("project", true)).cacheHit, true);
  deferred = false;
  finish();
  await fresh;
  now = 305_001;
  assert.notEqual((await controller.read("project", true)).cacheHit, true);
  assert.equal(scans, 3);
  await controller.read("sibling");
  await assert.rejects(controller.mutate({
    projectId: "project", rootId: "root", mode: "amend", expectedHead: "a".repeat(40), targetCommit: "a".repeat(40),
    title: "message", description: "", selections: [],
  }), /publication failed/);
  assert.notEqual((await controller.read("sibling", true)).cacheHit, true);
  await controller.dispose();
  await assert.rejects(controller.read("project", true), /reload/);
});
