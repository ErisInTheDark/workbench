/*
 * No production exports. Tests cover atomic index/ref publication, object framing, combined file changes, direct worktree dirt and large path/ref selections.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import GitObjectReadSession from "./GitObjectReadSession";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF } from "./WorkbenchGitRepository";
import parseGitFileChangeOutput from "./git-file-change-output";
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
  await GitObjectReadSession.run(async () => {
    const ref = "refs/worktree/object-reader-freshness";
    assert.equal(await repository.readBlobAtRef(ref), null);
    const first = await repository.writeBlob("first\n");
    await repository.updateRef(ref, first);
    assert.deepEqual(await repository.readBlobAtRef(ref), { blob: first, contents: "first\n" });
    await repository.run(["pack-refs", "--all"]);
    const second = await repository.writeBlob("second\n");
    await repository.updateRef(ref, second);
    await GitObjectReadSession.run(async () => {
      assert.deepEqual(await repository.readBlobAtRef(ref), { blob: second, contents: "second\n" });
      assert.equal(await repository.resolveCommit(initial.slice(0, 12)), initial);
      assert.equal(await repository.resolveTree(initial), snapshot.tree);
    });
    await repository.deleteRef(ref, second);
    assert.equal(await repository.readBlobAtRef(ref), null);
    await repository.updateRef(ref, first);
    assert.deepEqual(await repository.readBlobAtRef(ref), { blob: first, contents: "first\n" });
  });
  assert.equal(await repository.currentHead(), initial);
  const failure = new Error("operation failed");
  await assert.rejects(GitObjectReadSession.run(async () => {
    assert.equal(await repository.resolveCommit(initial), initial);
    throw failure;
  }), (error) => error === failure);
  await GitObjectReadSession.run(async () => assert.equal(await repository.resolveTree(initial), snapshot.tree));
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

test("batch object decoding isolates missing and wrong-type objects", async (context) => {
  const repository = new WorkbenchGitRepository(process.cwd());
  const contents = Buffer.from("nul\0 and multibyte \u03bb\n");
  const blobId = "a".repeat(40);
  const commitId = "b".repeat(40);
  const rawCommit = Buffer.from(`tree ${"c".repeat(40)}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nmessage\n`);
  context.mock.method(GitObjectReadSession, "read", async () => [
    { objectId: blobId, type: "blob", size: contents.length, contents },
    null,
    { objectId: commitId, type: "commit", size: rawCommit.length, contents: rawCommit },
    { objectId: blobId, type: "blob", size: 5, contents: Buffer.from("last\n") },
  ]);
  const expressions = ["refs/test/blob", "refs/test/missing", "refs/test/commit", "refs/test/last"];
  const blobs = await repository.readBlobs(expressions);
  assert.deepEqual(blobs.blobs.get(expressions[0]!), { blob: blobId, contents: contents.toString("utf8") });
  assert.equal(blobs.blobs.get(expressions[1]!), null);
  assert.equal(blobs.errors.has(expressions[2]!), true);
  assert.deepEqual(blobs.blobs.get(expressions[3]!), { blob: blobId, contents: "last\n" });
  const commits = await repository.readCommits(expressions);
  assert.equal(commits.commits.get(expressions[2]!)?.message, "message\n");
  for (const expression of [expressions[0]!, expressions[1]!, expressions[3]!]) {
    assert.equal(commits.errors.has(expression), true);
  }
});

test("combined diffs keep unusual paths and patch bytes without treating content as headers", () => {
  const filePath = "odd\tname\nwith spaces.txt";
  const patch = "diff --git \"a/odd\" \"b/odd\"\n--- a/odd\n+++ b/odd\n@@ -1 +1 @@\n-old\r\n+diff --git is content\r\n";
  const output = `:100644 100644 aaaaaaa bbbbbbb M\0${filePath}\0`
    + `1\t1\t${filePath}\0\0${patch}`;
  assert.deepEqual(parseGitFileChangeOutput(output), {
    kind: "changes",
    changes: [{ additions: 1, deletions: 1, diff: patch, kind: { type: "update", move_path: null }, path: filePath }],
  });
  assert.throws(() => parseGitFileChangeOutput(output.replace(`1\t1\t${filePath}`, "1\t1\twrong.txt")), /counts.*paths/u);
  assert.throws(() => parseGitFileChangeOutput(output.replace("\0\0diff", "\0bad\0diff")), /separator/u);
  assert.throws(() => parseGitFileChangeOutput(output.slice(0, output.indexOf("diff --git"))), /patches/u);
});

test("combined diffs preserve per-file colour output and isolate nested submodule headers", () => {
  const first = "diff --git a/one b/one\u001b[m\n\u001b[32m+one\u001b[m\n";
  const second = "diff --git a/two b/two\u001b[m\n\u001b[32m+two\u001b[m\n";
  const metadata = ":100644 100644 aaaaaaa bbbbbbb M\0one\0:100644 100644 aaaaaaa bbbbbbb M\0two\0"
    + "1\t0\tone\x001\t0\ttwo\0\0";
  const parsed = parseGitFileChangeOutput(`${metadata}\u001b[1m${first}\u001b[1m${second}`);
  assert.equal(parsed.kind, "changes");
  if (parsed.kind === "changes") assert.deepEqual(parsed.changes.map(({ diff }) => diff), [first, second]);
  assert.deepEqual(parseGitFileChangeOutput(
    ":160000 160000 aaaaaaa bbbbbbb M\0module\x001\t1\tmodule\0\0"
    + "Submodule module\ndiff --git a/one b/one\n+one\ndiff --git a/two b/two\n+two\n",
  ), { kind: "gitlinks", paths: ["module"] });
});

test("scoped diff batching excludes unrelated patches before collecting output", async (context) => {
  const repository = new WorkbenchGitRepository(process.cwd());
  const patch = "diff --git a/selected[1] b/selected[1]\n+selected\n";
  context.mock.method(repository, "run", async (args: string[]) => {
    if (!args.includes(":(top,literal)selected[1]")) throw new Error("Unrelated patches exceeded output capacity.");
    return ":100644 100644 aaaaaaa bbbbbbb M\0selected[1]\0"
      + `1\t0\tselected[1]\0\0${patch}`;
  });
  const changes = await repository.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected[1]"]);
  assert.deepEqual(changes.map(({ path: filePath, diff }) => [filePath, diff]), [["selected[1]", patch]]);
});

test("diff batching falls back only for capacity limits and preserves per-file failures", async (context) => {
  const patch = "diff --git a/selected b/selected\n+selected\n";
  const failures = [
    Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    Object.assign(new Error("spawn git E2BIG"), { code: "E2BIG" }),
    Object.assign(new Error("spawn git ENAMETOOLONG"), { code: "ENAMETOOLONG" }),
  ];
  for (const failure of failures) {
    const repository = new WorkbenchGitRepository(process.cwd());
    let combinedReads = 0;
    let singleReads = 0;
    let singleFailure: Error | undefined;
    context.mock.method(repository, "run", async (args: string[]) => {
      if (args.includes("--name-only")) return "selected\0unrelated\0";
      if (args.includes("-z")) {
        combinedReads += 1;
        throw failure;
      }
      singleReads += 1;
      if (singleFailure) throw singleFailure;
      assert.equal(args.at(-1), ":(top,literal)selected");
      return `:100644 100644 aaaaaaa bbbbbbb M\tselected\n1\t0\tselected\n${patch}`;
    });
    const changes = await repository.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected"]);
    assert.deepEqual(changes.map(({ diff }) => diff), [patch]);
    assert.equal(combinedReads, 1);
    assert.equal(singleReads, 1);
    singleFailure = new Error("single-file failure");
    await assert.rejects(repository.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected"]), (error) => error === singleFailure);
    assert.equal(singleReads, 2);
  }
  for (const failure of [
    new Error("repository inaccessible"),
    Object.assign(new RangeError("stderr maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
  ]) {
    const repository = new WorkbenchGitRepository(process.cwd());
    const calls = context.mock.method(repository, "run", async () => { throw failure; });
    await assert.rejects(repository.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected"]), (error) => error === failure);
    assert.equal(calls.mock.callCount(), 1);
  }
});

test("file-change construction passes cancellation through combined and fallback Git reads", async (context) => {
  const signal = new AbortController().signal;
  const patch = "diff --git a/selected b/selected\n+selected\n";
  const combined = new WorkbenchGitRepository(process.cwd());
  const combinedSignals: Array<AbortSignal | undefined> = [];
  context.mock.method(combined, "run", async (_args, _env, receivedSignal) => {
    combinedSignals.push(receivedSignal);
    return `:100644 100644 aaaaaaa bbbbbbb M\0selected\0`
      + `1\t0\tselected\0\0${patch}`;
  });
  await combined.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected"], signal);
  assert.deepEqual(combinedSignals, [signal]);

  const fallback = new WorkbenchGitRepository(process.cwd());
  const fallbackSignals: Array<AbortSignal | undefined> = [];
  context.mock.method(fallback, "run", async (args, _env, receivedSignal) => {
    fallbackSignals.push(receivedSignal);
    if (args.includes("--name-only")) return "selected\0";
    if (args.includes("-z")) {
      throw Object.assign(new Error("spawn git E2BIG"), { code: "E2BIG" });
    }
    return `:100644 100644 aaaaaaa bbbbbbb M\tselected\n1\t0\tselected\n${patch}`;
  });
  await fallback.buildFileChanges("a".repeat(40), "b".repeat(40), ["selected"], signal);
  assert.deepEqual(fallbackSignals, [signal, signal, signal]);
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
  const branch = await repository.symbolicHead();
  assert.ok(branch);
  assert.deepEqual(await repository.readCommitRef(head, "refs/heads"), { ...commit, ref: branch });
  assert.equal(await repository.readCommitRef(head, "refs/worktree/absent"), null);

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
  await assert.rejects(repository.readCommitRef(blob, "refs/worktree/workbench/test-object"), /is not a commit/u);

  await fs.writeFile(path.join(fixture.root, "selected.txt"), "selected changed\nsecond line\n", "utf8");
  await fs.rm(path.join(fixture.root, "ordinary.txt"));
  await fs.writeFile(path.join(fixture.root, "literal[1].txt"), "literal addition\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const paths = ["binary.bin", "literal[1].txt", "ordinary.txt", "selected.txt"];
  const tree = await repository.writeScopedWorktreeTree(paths);
  assert.deepEqual(await repository.listAllChangedPaths("HEAD", tree), paths);
  const commands = context.mock.method(repository, "run", repository.run.bind(repository));
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
  const diffReads = commands.mock.calls.filter(({ arguments: [args] }) => args[0] === "diff").length;
  commands.mock.restore();
  assert.ok(diffReads <= 1, `multi-file inspection needed ${diffReads} diff queries`);
  assert.deepEqual(await repository.buildFileChanges(head, tree, ["literal[1].txt"]), [
    changes.find(({ path: filePath }) => filePath === "literal[1].txt"),
  ]);
  const selectedTree = await repository.writeTreeWithPathsFromSource(head, tree, ["literal[1].txt"]);
  assert.deepEqual(await repository.listAllChangedPaths(head, selectedTree), ["literal[1].txt"]);
  assert.notEqual(selectedTree, tree);
  assert.equal(await repository.writeTreeWithPathsFromSource(selectedTree, tree, ["literal[1].txt"]), selectedTree);
  const gitlinkTree = (await repository.runWithInput(["mktree"], `160000 commit ${head}\tmodule\n`)).trim();
  const linkChanges = await repository.buildFileChanges(head, gitlinkTree, ["module"]);
  assert.deepEqual(linkChanges.map(({ path: filePath, kind }) => ({ path: filePath, kind })), [
    { path: "module", kind: { type: "add" } },
  ]);
  assert.match(linkChanges[0]?.diff ?? "", /Subproject commit/u);

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
  const replacement = await repository.createCommitFromTree(commit!.identity.tree, null, "replacement metadata\n");
  await repository.run(["replace", head, replacement]);
  assert.deepEqual(await repository.readCommitRef(head, "refs/heads"), {
    ...await repository.readCommitAt(head), ref: branch,
  });
  const missingCommit = "f".repeat(40);
  await fs.writeFile(path.join(fixture.root, ".git", "refs", "worktree", "workbench", "dangling"), `${missingCommit}\n`);
  assert.equal(await repository.readCommitRef(missingCommit, "refs/worktree/workbench/dangling"), null);
});
