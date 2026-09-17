/* No production exports. Real repositories protect selected mutations and unrelated work. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import type { WorkingTreeMutation } from "workbench-shared/workbench/git/working-tree-contracts";
import GitTestFixtureCache from "./GitTestFixtureCache";
import { THREAD_GIT_BASE_FIXTURE, UNBORN_FIXTURE } from "./WorkbenchGitTestFixtures";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchWorkingTreeRepository from "./WorkbenchWorkingTreeRepository";

const fixtures = new GitTestFixtureCache();
for (const mode of ["commit", "amend", "stash", "discard"] as const) {
  test(`${mode} consumes only selected content and preserves unrelated staging`, async context => {
    const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
    context.after(fixture.dispose);
    const git = await WorkbenchGitRepository.open(fixture.root);
    const owner = new WorkbenchWorkingTreeRepository(git);
    await fs.writeFile(path.join(fixture.root, "selected.txt"), "replacement\nexcluded\n");
    await fs.writeFile(path.join(fixture.root, "ordinary.txt"), "staged outside\n");
    await git.run(["add", "ordinary.txt"]);
    const outside = await git.run(["show", ":ordinary.txt"]);
    const snapshot = await owner.read();
    const file = snapshot.files.find(file => file.path === "selected.txt")!;
    const diff = await owner.diff(snapshot, file);
    const ids = describeWorkingTreeDiff(diff.patch).rows
      .filter(row => row.type === "deletion" || row.text === "replacement").map(row => row.id);
    const request: WorkingTreeMutation = {
      projectId: "project", rootId: "root", mode, expectedHead: snapshot.head,
      targetCommit: mode === "amend" ? snapshot.head : null, title: "selected change", description: "",
      selections: [{ path: file.path, identity: file.identity, lineIds: ids }],
    };
    const result = await owner.mutate(snapshot, request, async () => {});
    assert.equal(result.status, "complete");
    assert.equal(await git.run(["show", ":ordinary.txt"]), outside);
    if (mode === "commit" || mode === "amend") {
      assert.equal(await git.run(["show", "HEAD:selected.txt"]), "replacement\n");
      assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "replacement\nexcluded\n");
      if (mode === "amend") {
        const later = await owner.read();
        const changed = later.files.find(file => file.path === "selected.txt")!;
        const create = git.createCommitFromTree.bind(git);
        git.createCommitFromTree = async (...args) => {
          const commit = await create(...args);
          await fs.writeFile(path.join(fixture.root, "selected.txt"), "late edit\n");
          return commit;
        };
        await assert.rejects(owner.mutate(later, {
          ...request, expectedHead: later.head, targetCommit: later.head,
          selections: [{ path: changed.path, identity: changed.identity, lineIds: null }],
        }, async () => {}), /changed/);
        assert.equal(await git.headOrNull(), later.head);
        assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "late edit\n");
      }
    } else {
      assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "selected base\nexcluded\n");
      if (mode === "stash") {
        assert.ok(result.stash);
        assert.equal(await git.run(["show", `${result.stash}:selected.txt`]), "replacement\n");
      }
    }
  });
}

test("initial commit works while stale selections and publication failures preserve work", async context => {
  const fixture = await fixtures.copy(UNBORN_FIXTURE);
  context.after(fixture.dispose);
  const git = await WorkbenchGitRepository.open(fixture.root);
  const owner = new WorkbenchWorkingTreeRepository(git);
  await fs.writeFile(path.join(fixture.root, "new.txt"), "new\n");
  const snapshot = await owner.read();
  const file = snapshot.files[0]!;
  const request: WorkingTreeMutation = {
    projectId: "project", rootId: "root", mode: "commit", expectedHead: null, targetCommit: null,
    title: "initial", description: "", selections: [{ path: file.path, identity: file.identity, lineIds: null }],
  };
  await assert.rejects(owner.mutate(snapshot, request, async () => { throw new Error("claim acquired"); }), /claim acquired/);
  assert.equal(await git.headOrNull(), null);
  await fs.writeFile(path.join(fixture.root, "new.txt"), "changed\n");
  await assert.rejects(owner.mutate(snapshot, request, async () => {}), /changed|stale/i);
  await fs.writeFile(path.join(fixture.root, "new.txt"), "new\n");
  assert.equal((await owner.mutate(snapshot, request, async () => {})).status, "complete");
  assert.equal(await git.run(["show", "HEAD:new.txt"]), "new\n");
});

test("submodule diffs do not require objects from the nested repository", async context => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const git = await WorkbenchGitRepository.open(fixture.root);
  const owner = new WorkbenchWorkingTreeRepository(git);
  const snapshot = await owner.read();
  const diff = await owner.diff(snapshot, {
    path: "nested", oldPath: null, status: "M", identity: "gitlink",
    baseBlob: "1".repeat(40), blob: "2".repeat(40), baseMode: "160000", mode: "160000",
    additions: 1, deletions: 1, partial: false, binary: false, ownerIds: [],
  });
  assert.ok(diff.unavailable);
  assert.equal(diff.patch, "");
});

test("a saved stash survives removal failure without losing work", async context => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const git = await WorkbenchGitRepository.open(fixture.root);
  const owner = new WorkbenchWorkingTreeRepository(git);
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "keep recoverable\n");
  const snapshot = await owner.read();
  const file = snapshot.files.find(file => file.path === "selected.txt")!;
  const run = git.runWithInput.bind(git);
  git.runWithInput = async (args, ...rest) => {
    if (args[0] === "apply" && !args.includes("--check")) throw new Error("removal denied");
    return await run(args, ...rest);
  };
  const result = await owner.mutate(snapshot, {
    projectId: "project", rootId: "root", mode: "stash", expectedHead: snapshot.head, targetCommit: null,
    title: "recoverable", description: "", selections: [{ path: file.path, identity: file.identity, lineIds: null }],
  }, async () => {});
  assert.equal(result.status, "incomplete");
  assert.equal((await git.run(["rev-parse", "refs/stash"])).trim(), result.stash);
  assert.equal(await git.run(["show", `${result.stash}:selected.txt`]), "keep recoverable\n");
  assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "keep recoverable\n");
});

test("failed commit publication restores selected staging and leaves worktree intact", async context => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const git = await WorkbenchGitRepository.open(fixture.root);
  const owner = new WorkbenchWorkingTreeRepository(git);
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "staged\n");
  await git.run(["add", "selected.txt"]);
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "working\n");
  const previousIndex = await git.writeIndexTree();
  const snapshot = await owner.read();
  const file = snapshot.files.find(file => file.path === "selected.txt")!;
  git.updateRefs = async () => { throw new Error("publication rejected"); };
  await assert.rejects(owner.mutate(snapshot, {
    projectId: "project", rootId: "root", mode: "commit", expectedHead: snapshot.head, targetCommit: null,
    title: "new", description: "", selections: [{ path: file.path, identity: file.identity, lineIds: null }],
  }, async () => {}), /publication rejected/);
  assert.equal(await git.headOrNull(), snapshot.head);
  assert.equal(await git.writeIndexTree(), previousIndex);
  assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "working\n");
});

test("removal is incomplete when Git leaves selected content in the worktree", async context => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const git = await WorkbenchGitRepository.open(fixture.root);
  const owner = new WorkbenchWorkingTreeRepository(git);
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "still present\n");
  const snapshot = await owner.read();
  const file = snapshot.files.find(file => file.path === "selected.txt")!;
  const run = git.runWithInput.bind(git);
  // Git can accept submodule patches without checking out the nested worktree.
  git.runWithInput = async (args, ...rest) => args[0] === "apply" && !args.includes("--check") ? "" : await run(args, ...rest);
  const result = await owner.mutate(snapshot, {
    projectId: "project", rootId: "root", mode: "discard", expectedHead: snapshot.head, targetCommit: null,
    title: "", description: "", selections: [{ path: file.path, identity: file.identity, lineIds: null }],
  }, async () => {});
  assert.equal(result.status, "incomplete");
  assert.equal(await fs.readFile(path.join(fixture.root, "selected.txt"), "utf8"), "still present\n");
});
