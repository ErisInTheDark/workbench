/*
 * No exports. Protect committed rename chains, ambiguity, merges, and path transport.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import { THREAD_GIT_BASE_FIXTURE } from "./WorkbenchGitTestFixtures.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import GitClaimRenameReader from "./GitClaimRenameReader.ts";

const fixtures = new GitTestFixtureCache();

test("committed chains retain the last name after deletion and ignore copies and worktree moves", async (context) => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const reader = new GitClaimRenameReader();
  const source = "nested/one.txt";
  const middle = "renamed space.txt";
  const target = "final space.txt";
  await repository.run(["mv", source, middle]);
  await repository.run(["commit", "-m", "rename one"]);
  await repository.run(["mv", middle, target]);
  await repository.run(["commit", "-m", "rename again"]);
  await fs.copyFile(path.join(fixture.root, target), path.join(fixture.root, "copy.txt"));
  await repository.run(["add", "copy.txt"]);
  await repository.run(["commit", "-m", "copy"]);
  await repository.run(["mv", target, "uncommitted.txt"]);
  const expected = [{ from: source, to: target }, { from: middle, to: target }].sort((a, b) => a.from.localeCompare(b.from));
  assert.deepEqual(await reader.read(repository, await repository.currentHead(), new AbortController().signal), expected);
  await repository.run(["mv", "uncommitted.txt", target]);
  await repository.run(["rm", target]);
  await repository.run(["commit", "-m", "delete"]);
  assert.deepEqual(await reader.read(repository, await repository.currentHead(), new AbortController().signal), expected);
});

test("reused names and rename cycles never combine different file generations", async (context) => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  await repository.run(["mv", "nested/one.txt", "moved.txt"]);
  await repository.run(["commit", "-m", "move"]);
  await fs.writeFile(path.join(fixture.root, "nested/one.txt"), "different file\n");
  await repository.run(["add", "nested/one.txt"]);
  await repository.run(["commit", "-m", "reuse"]);
  await repository.run(["mv", "nested/two.txt", "cycle.txt"]);
  await repository.run(["commit", "-m", "cycle out"]);
  await repository.run(["mv", "cycle.txt", "nested/two.txt"]);
  await repository.run(["commit", "-m", "cycle back"]);
  assert.deepEqual(await new GitClaimRenameReader().read(repository, await repository.currentHead(), new AbortController().signal), []);
});

test("merge renames are read relative to the first parent", async (context) => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const base = await repository.currentHead();
  await repository.run(["checkout", "-b", "rename-topic"]);
  await repository.run(["mv", "nested/one.txt", "merged.txt"]);
  await repository.run(["commit", "-m", "topic move"]);
  await repository.run(["checkout", "-b", "rename-main", base]);
  await repository.run(["merge", "--no-ff", "rename-topic", "-m", "merge"]);
  assert.deepEqual(await new GitClaimRenameReader().read(repository, await repository.currentHead(), new AbortController().signal), [
    { from: "nested/one.txt", to: "merged.txt" },
  ]);
});

test("NUL-delimited history preserves tabs and newlines in git paths", { skip: process.platform === "win32" }, async (context) => {
  const fixture = await fixtures.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const target = "name\twith\nbreaks.txt";
  await repository.run(["mv", "nested/one.txt", target]);
  await repository.run(["commit", "-m", "unusual path"]);
  assert.deepEqual(await new GitClaimRenameReader().read(repository, await repository.currentHead(), new AbortController().signal), [
    { from: "nested/one.txt", to: target },
  ]);
});
