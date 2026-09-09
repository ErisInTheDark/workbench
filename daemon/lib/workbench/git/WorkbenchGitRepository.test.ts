/*
 * No production exports. Regression wards cover index-normalized ref publication, retry safety, object reads, exact combined file-change inspection, direct worktree dirt, and large stdin path and ref-pattern sets. Keywords: git, repository, index, ref, retry, object, diff, dirt, pathspec, stdin, argv, large path set.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF } from "./WorkbenchGitRepository";
import { THREAD_GIT_BASE_FIXTURE, UNBORN_FIXTURE } from "./WorkbenchGitTestFixtures";

const fixtureCache = new GitTestFixtureCache();

test("unborn snapshots preserve staged and untracked files without creating branch history", async (context) => {
  const fixture = await fixtureCache.copy(UNBORN_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  await fs.writeFile(path.join(fixture.root, "staged.txt"), "staged\n");
  await repository.run(["add", "staged.txt"]);
  await fs.writeFile(path.join(fixture.root, "staged.txt"), "working\n");
  await fs.writeFile(path.join(fixture.root, "untracked.txt"), "untracked\n");
  const index = await repository.writeIndexTree();
  const snapshot = await repository.writeWorktreeSnapshot();
  assert.equal(snapshot.head, null);
  assert.deepEqual(await repository.listTreePaths(snapshot.tree), ["staged.txt", "untracked.txt"]);
  assert.equal(await repository.run(["show", `${snapshot.tree}:staged.txt`]), "working\n");
  assert.equal(await repository.writeIndexTree(), index);
  assert.equal(await repository.readRef("HEAD"), null);
  const initial = await repository.createCommitFromTree(snapshot.tree, [], "external first\n");
  const branch = await repository.symbolicHead();
  assert.ok(branch);
  await repository.updateRef(branch, initial);
  const competing = await repository.createCommitFromTree(snapshot.tree, [], "competing first\n");
  await assert.rejects(repository.publishRefsAfterIndexNormalization({
    indexCommit: competing,
    paths: ["staged.txt"],
    updates: [{ ref: branch, newValue: competing, oldValue: "0".repeat(initial.length) }],
  }), /reference|exists/u);
  assert.equal(await repository.currentHead(), initial);
  assert.equal(await repository.writeIndexTree(), index);
});

test("large ref pattern sets preserve filtering, overlap deduplication, and object types", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const commit = await repository.currentHead();
  const blob = await repository.writeBlob("ref pattern fixture\n");
  const prefix = "refs/worktree/ref-pattern-test";
  const selectedCommit = `${prefix}/selected/commit`;
  const selectedBlob = `${prefix}/selected/blob`;
  const unrelated = `${prefix}/unrelated`;
  await repository.updateRefs([
    { ref: selectedCommit, newValue: commit },
    { ref: selectedBlob, newValue: blob },
    { ref: unrelated, newValue: commit },
  ]);
  const patterns = Array.from({ length: 2_000 }, (_, index) => `${prefix}/missing-${index}`);
  patterns.push(`${prefix}/selected`, selectedCommit, `${prefix}/selected`);
  const selected = await repository.listRefsWithValues(...patterns);
  assert.deepEqual(selected, [
    { objectType: "blob", ref: selectedBlob, value: blob },
    { objectType: "commit", ref: selectedCommit, value: commit },
  ]);
  const all = await repository.listRefsWithValues();
  assert.deepEqual(all.filter(({ ref }) => ref.startsWith(`${prefix}/`)), [
    ...selected,
    { objectType: "commit", ref: unrelated, value: commit },
  ]);
});

test("repository containment preserves Windows aliases but rejects differently cased Linux siblings", () => {
  const root = path.resolve("case-parent", "Repo");
  const sibling = path.resolve("case-parent", "repo", "file.md");
  const windows = new WorkbenchGitRepository(root, "win32");
  const linux = new WorkbenchGitRepository(root, "linux");
  assert.equal(windows.resolvePath(sibling), sibling);
  assert.throws(() => linux.resolvePath(sibling), /inside the repository/u);
  assert.throws(() => linux.normalizePaths([sibling]), /inside the Git repository/u);
  for (const repository of [windows, linux]) {
    assert.equal(repository.resolvePath("file.md"), path.join(root, "file.md"));
    assert.throws(() => repository.resolvePath("../Repository/file.md"), /inside the repository/u);
    assert.throws(() => repository.resolvePath("../other/file.md"), /inside the repository/u);
  }
});

test("normalizes the index before atomic ref publication and keeps retries idempotent", async () => {
  const repository = new WorkbenchGitRepository("C:/Git/Project");
  const events: string[] = [];
  const mutable = repository as unknown as {
    resetMixedPaths(commit: string, paths: string[]): Promise<void>;
    updateRefs(updates: Array<{ newValue: string; oldValue?: string; ref: string }>): Promise<void>;
    writeIndexTree(): Promise<string>;
  };
  const previousIndexTree = "c".repeat(40);
  let normalizationFails = true;
  mutable.writeIndexTree = async () => {
    events.push("snapshot");
    return previousIndexTree;
  };
  mutable.resetMixedPaths = async (commit) => {
    events.push(commit === previousIndexTree ? "rollback" : "normalize");
    if (normalizationFails) throw new Error("index locked");
  };
  mutable.updateRefs = async () => { events.push("publish"); };
  const request = {
    indexCommit: "a".repeat(40),
    paths: ["new-file.ts"],
    updates: [{ newValue: "a".repeat(40), oldValue: "b".repeat(40), ref: "refs/heads/main" }],
  };

  await assert.rejects(repository.publishRefsAfterIndexNormalization(request), /index locked/u);
  assert.deepEqual(events, ["snapshot", "normalize"]);
  normalizationFails = false;
  await repository.publishRefsAfterIndexNormalization(request);
  assert.deepEqual(events, ["snapshot", "normalize", "snapshot", "normalize", "publish"]);

  events.length = 0;
  let publicationFails = true;
  mutable.updateRefs = async () => {
    events.push("publish");
    if (publicationFails) throw new Error("ref changed");
  };
  await assert.rejects(repository.publishRefsAfterIndexNormalization(request), /ref changed/u);
  assert.deepEqual(events, ["snapshot", "normalize", "publish", "rollback"]);
  publicationFails = false;
  await repository.publishRefsAfterIndexNormalization(request);
  assert.deepEqual(events, [
    "snapshot", "normalize", "publish", "rollback",
    "snapshot", "normalize", "publish",
  ]);
});

test("new-file index locks block ref publication until the same operation retries", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const oldHead = await repository.currentHead();
  const headRef = await repository.symbolicHead();
  assert.ok(headRef);
  await fs.writeFile(path.join(fixture.root, "new-file.ts"), "new file\n", "utf8");
  const tree = await repository.writeScopedWorktreeTree(["new-file.ts"]);
  const commit = await repository.createCommitFromTree(tree, oldHead, "add new file");
  const request = {
    indexCommit: commit,
    paths: ["new-file.ts"],
    updates: [{ newValue: commit, oldValue: oldHead, ref: headRef }],
  };
  const lockPath = path.resolve(fixture.root, (await repository.run(["rev-parse", "--git-path", "index.lock"])).trim());
  await fs.writeFile(lockPath, "locked\n", "utf8");
  context.after(async () => { await fs.rm(lockPath, { force: true }); });

  await assert.rejects(repository.publishRefsAfterIndexNormalization(request), /index\.lock/u);
  assert.equal(await repository.currentHead(), oldHead);
  assert.match(await repository.run(["status", "--short", "--", "new-file.ts"]), /^\?\? new-file\.ts/mu);

  await fs.rm(lockPath, { force: true });
  await repository.publishRefsAfterIndexNormalization(request);
  assert.equal(await repository.currentHead(), commit);
  assert.equal(await repository.run(["status", "--short", "--", "new-file.ts"]), "");
});

test("every ref transaction advances generation even when ref values repeat", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const head = await repository.currentHead();
  const missing = "0".repeat(40);
  const firstRef = "refs/worktree/workbench/generation-first";
  const secondRef = "refs/worktree/workbench/generation-second";
  const blockedRef = "refs/worktree/workbench/generation-blocked";

  await repository.updateRefs([{ newValue: head, oldValue: missing, ref: firstRef }]);
  const firstGeneration = await repository.readRef(GIT_STATE_GENERATION_REF);
  assert.ok(firstGeneration);
  await repository.updateRefs([{ newValue: head, oldValue: missing, ref: secondRef }]);
  const secondGeneration = await repository.readRef(GIT_STATE_GENERATION_REF);
  assert.ok(secondGeneration);
  assert.notEqual(secondGeneration, firstGeneration);

  await assert.rejects(repository.updateRefs(
    [{ newValue: head, oldValue: missing, ref: blockedRef }],
    [],
    { expectedStateGeneration: firstGeneration },
  ), /state-generation/u);
  assert.equal(await repository.readRef(blockedRef), null);
  assert.equal(await repository.readRef(GIT_STATE_GENERATION_REF), secondGeneration);
});

test("direct worktree dirt uses final file content across staged, deleted, untracked, ignored, and unusual paths", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const head = await repository.currentHead();
  const unusualPath = "odd [name].txt";
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "staged intermediate\n", "utf8");
  await repository.run(["add", "--", "selected.txt"]);
  await fs.writeFile(path.join(fixture.root, "selected.txt"), "final worktree content\n", "utf8");
  await fs.rm(path.join(fixture.root, "ordinary.txt"));
  await fs.writeFile(path.join(fixture.root, unusualPath), "untracked content\n", "utf8");
  await fs.writeFile(path.join(fixture.root, ".gitignore"), "ignored/\n", "utf8");
  await fs.mkdir(path.join(fixture.root, "ignored"));
  await fs.writeFile(path.join(fixture.root, "ignored", "output.txt"), "ignored content\n", "utf8");
  const indexBefore = await repository.run(["diff", "--cached", "--binary"]);
  const expected = [".gitignore", "ordinary.txt", "selected.txt", unusualPath]
    .sort((left, right) => left.localeCompare(right));
  const scopes = [...expected, "ignored"];

  assert.deepEqual(await repository.listWorktreeChangedPaths(head, scopes), expected);
  const worktreeTree = await repository.writeScopedWorktreeTree(expected, head);
  assert.deepEqual(await repository.listWorktreeChangedPaths(worktreeTree, scopes), []);
  await fs.writeFile(path.join(fixture.root, unusualPath), "newer untracked content\n", "utf8");
  assert.deepEqual(await repository.listWorktreeChangedPaths(worktreeTree, scopes), [unusualPath]);
  assert.equal(await repository.run(["diff", "--cached", "--binary"]), indexBefore);
});

test("reads objects and preserves exact changes across literal, binary, and large pathsets with real Git", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const cancellation = new AbortController();
  cancellation.abort(new Error("cancel scoped snapshot"));
  await assert.rejects(
    repository.writeScopedWorktreeTree(["ordinary.txt"], "HEAD", cancellation.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const head = await repository.currentHead();
  const commit = await repository.readCommitAt("HEAD");
  assert.equal(commit?.commit, head);
  assert.equal(commit?.identity.message, "base\n");
  assert.equal(commit?.identity.parents.length, 0);
  assert.match(commit?.identity.tree ?? "", /^[a-f0-9]{40}$/u);

  const blob = await repository.writeBlob("registry contents\n");
  await repository.updateRef("refs/worktree/workbench/test-object", blob);
  assert.deepEqual(await repository.readBlobAtRef("refs/worktree/workbench/test-object"), {
    blob,
    contents: "registry contents\n",
  });
  assert.equal(await repository.readBlobAtRef("refs/worktree/workbench/missing-object"), null);
  assert.equal(await repository.readCommitAt("refs/worktree/workbench/missing-object"), null);
  await assert.rejects(repository.readBlobAtRef("HEAD"), /does not resolve to a blob/u);
  await assert.rejects(repository.readCommitAt("refs/worktree/workbench/test-object"), /is not a commit/u);

  await fs.writeFile(path.join(fixture.root, "selected.txt"), "selected changed\nsecond line\n", "utf8");
  await fs.rm(path.join(fixture.root, "ordinary.txt"));
  await fs.writeFile(path.join(fixture.root, "literal[1].txt"), "literal addition\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const paths = ["binary.bin", "literal[1].txt", "ordinary.txt", "selected.txt"];
  const tree = await repository.writeScopedWorktreeTree(paths);
  assert.deepEqual(await repository.listAllChangedPaths("HEAD", tree), paths);
  const changes = await repository.buildFileChanges("HEAD", tree, paths);

  assert.deepEqual(changes.map(({ additions, deletions, kind, path: filePath }) => ({
    additions,
    deletions,
    kind: kind.type,
    path: filePath,
  })), [
    { additions: 0, deletions: 0, kind: "add", path: "binary.bin" },
    { additions: 1, deletions: 0, kind: "add", path: "literal[1].txt" },
    { additions: 0, deletions: 1, kind: "delete", path: "ordinary.txt" },
    { additions: 2, deletions: 1, kind: "update", path: "selected.txt" },
  ]);
  assert(changes.every(({ diff }) => diff.startsWith("diff --git ")));
  assert.match(changes.find(({ path: filePath }) => filePath === "binary.bin")?.diff ?? "", /GIT binary patch/u);
  assert.match(changes.find(({ path: filePath }) => filePath === "literal[1].txt")?.diff ?? "", /literal addition/u);

  const bulkDirectory = path.join(fixture.root, "bulk");
  await fs.mkdir(bulkDirectory);
  const bulkPaths = Array.from({ length: 250 }, (_value, index) => (
    `bulk/${String(index).padStart(4, "0")}-${"x".repeat(125)}.txt`
  ));
  assert.ok(Buffer.byteLength(bulkPaths.map((candidate) => `:(top,literal)${candidate}`).join("\0")) > 32 * 1024);
  await Promise.all(bulkPaths.map(async (filePath, index) => {
    await fs.writeFile(path.join(fixture.root, filePath), `${index}\n`, "utf8");
  }));

  const bulkTree = await repository.writeScopedWorktreeTree(bulkPaths);
  assert.deepEqual(await repository.listChangedPaths(head, bulkTree, bulkPaths), bulkPaths);
  assert.deepEqual(await repository.listTreePaths(bulkTree, bulkPaths), bulkPaths);
  assert.equal(await repository.writeTreeWithPathsFromSource(head, bulkTree, bulkPaths), bulkTree);

  const bulkCommit = await repository.createCommitFromTree(bulkTree, head, "large pathset");
  await repository.resetMixedPaths(bulkCommit, bulkPaths);
  await Promise.all(bulkPaths.map(async (filePath) => {
    await fs.writeFile(path.join(fixture.root, filePath), "dirty\n", "utf8");
  }));
  await repository.restorePaths(bulkCommit, bulkPaths);
  assert.equal(await fs.readFile(path.join(fixture.root, bulkPaths[0]!), "utf8"), "0\n");
  assert.equal(await fs.readFile(path.join(fixture.root, bulkPaths.at(-1)!), "utf8"), "249\n");
});
