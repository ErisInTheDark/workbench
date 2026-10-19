/*
 * No production exports. Tests protect the Workbench Library becoming a Git repository whose generated instruction
 * files are excluded while user-owned files stay visible.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";

const execute = promisify(execFile);

async function isGitIgnored(root: string, relativePath: string) {
  try {
    await execute("git", ["-C", root, "check-ignore", "-q", "--", relativePath], { windowsHide: true });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

test("ensuring the library creates a repository that ignores only generated instruction files", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-library-git-");
  const libraryRoot = path.join(temporary.path, "library");
  const previousLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
  context.after(async () => {
    if (previousLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
    else process.env.WORKBENCH_LIBRARY_ROOT = previousLibraryRoot;
    await temporary.dispose();
  });
  process.env.WORKBENCH_LIBRARY_ROOT = libraryRoot;
  const { ensureWorkbenchLibrary } = await import("./workbench-library");
  const { readWorkbenchInstructionSources } = await import("./workbench/instructions/instruction-source");
  const { resolveGitDirectory } = await import("./git");

  await Promise.all([ensureWorkbenchLibrary(), ensureWorkbenchLibrary()]);

  assert.ok(await resolveGitDirectory(libraryRoot));
  const [generated] = await readWorkbenchInstructionSources();
  assert.ok(generated);
  assert.equal(await isGitIgnored(libraryRoot, generated.relativePath), true);
  assert.equal(await isGitIgnored(libraryRoot, generated.relativePath.replace(/\.md$/u, ".override.md")), false);
  assert.equal(await isGitIgnored(libraryRoot, "README.md"), false);
});
