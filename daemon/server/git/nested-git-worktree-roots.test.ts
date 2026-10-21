/*
 * Exports:
 * - No production exports; tests protect nested worktree root discovery, stable root ids and checkout ownership checks.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import {
  isNestedGitWorktreeOf,
  isNestedGitWorktreeRoot,
  withNestedGitWorktreeRoots,
  type NestedGitWorktreeCatalogProject,
} from "./nested-git-worktree-roots";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createCheckout(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-nested-worktrees-");
  context.after(async () => await temporary.dispose());
  const parent = await realpath(temporary.path);
  const main = path.join(parent, "main");
  await mkdir(main);
  await git(main, "init", "-q");
  await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  const addWorktree = async (target: string, branch: string) => {
    await git(main, "worktree", "add", "-q", "-b", branch, target);
    return target;
  };
  return { addWorktree, main, parent };
}

function resolution(main: string): AgentEndpointProjectResolution {
  const root = { id: "main", name: "main", root: main, rootPath: main };
  return { cwd: main, project: { id: ProjectIdSchema.parse("main-project"), kind: "git", root: main, rootPath: main, roots: [root] }, root };
}

function catalogProject(id: string, rootPath: string): NestedGitWorktreeCatalogProject {
  return {
    id: ProjectIdSchema.parse(id), kind: "git", rootPath,
    roots: [{ id: `${id}-root`, isPrimary: true, name: id, relativePath: id, rootPath }],
  };
}

test("only catalogued worktrees registered inside a project root join its arc", async (context) => {
  const { addWorktree, main, parent } = await createCheckout(context);
  const lab = await addWorktree(path.join(main, ".worktrees", "lab"), "lab");
  const uncatalogued = await addWorktree(path.join(main, ".worktrees", "uncatalogued"), "uncatalogued");
  const outside = await addWorktree(path.join(parent, "outside"), "outside");
  const gone = await addWorktree(path.join(main, ".worktrees", "gone"), "gone");
  await rm(gone, { recursive: true, force: true });
  const unregistered = path.join(main, "vendored");
  await mkdir(unregistered);
  await git(unregistered, "init", "-q");

  const resolved = await withNestedGitWorktreeRoots(resolution(main), [
    catalogProject("main-project", main),
    catalogProject("lab", lab),
    catalogProject("outside", outside),
    catalogProject("gone", gone),
    catalogProject("vendored", unregistered),
  ]);
  const nested = resolved.project.roots.filter(isNestedGitWorktreeRoot);
  assert.deepEqual(nested.map(({ id, nestedWorktree, root }) => ({ id, nestedWorktree, root })), [
    { id: "lab", nestedWorktree: { projectId: "lab", rootId: "lab-root" }, root: lab },
  ]);
  assert.equal(resolved.project.roots[0]!.id, "main");
  assert.equal(resolved.root.id, "main");
  assert.ok(!resolved.project.roots.some(({ root }) => root === uncatalogued));
});

test("colliding nested worktree names fall back to their containing-root paths", async (context) => {
  const { addWorktree, main } = await createCheckout(context);
  const first = await addWorktree(path.join(main, "a", "lab"), "first");
  const second = await addWorktree(path.join(main, "b", "lab"), "second");
  const namedLikeRoot = await addWorktree(path.join(main, ".worktrees", "main"), "named-like-root");
  const unique = await addWorktree(path.join(main, ".worktrees", "solo"), "solo");
  const resolved = await withNestedGitWorktreeRoots(resolution(main), [
    catalogProject("first", first), catalogProject("second", second),
    catalogProject("named", namedLikeRoot), catalogProject("solo", unique),
  ]);
  assert.deepEqual(resolved.project.roots.filter(isNestedGitWorktreeRoot).map(({ id }) => id).sort(), [
    ".worktrees-main", "a-lab", "b-lab", "solo",
  ]);
});

test("a nested worktree belongs only to the checkout that registers and contains it", async (context) => {
  const { addWorktree, main, parent } = await createCheckout(context);
  const lab = await addWorktree(path.join(main, ".worktrees", "lab"), "lab");
  const outside = await addWorktree(path.join(parent, "outside"), "outside");
  const unregistered = path.join(main, "vendored");
  await mkdir(unregistered);
  await git(unregistered, "init", "-q");
  assert.equal(await isNestedGitWorktreeOf(main, lab), true);
  assert.equal(await isNestedGitWorktreeOf(main, main), false);
  assert.equal(await isNestedGitWorktreeOf(main, outside), false);
  assert.equal(await isNestedGitWorktreeOf(main, unregistered), false);
  assert.equal(await isNestedGitWorktreeOf(outside, lab), false);
});
