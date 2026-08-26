/*
 * No production exports. Regression wards cover index-normalized ref publication, retry safety, object reads, and exact combined file-change inspection. Keywords: git, repository, index, ref, retry, object, diff.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { THREAD_GIT_BASE_FIXTURE } from "./WorkbenchGitTestFixtures";

const fixtureCache = new GitTestFixtureCache();

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

test("reads ref objects and inspects text, binary, and literal-path changes with real Git", async (context) => {
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
});
