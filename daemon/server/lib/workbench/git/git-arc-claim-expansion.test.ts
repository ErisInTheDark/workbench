/* No production exports. Wards that folder claims become the Git-visible files they hold, and moves claim derived destinations. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { expandGitArcClaimPaths, expandGitArcMoveClaimPaths } from "./git-arc-claim-expansion.ts";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import { PATH_MOVER_BASE_FIXTURE } from "./WorkbenchGitTestFixtures.ts";

test("folders expand to their tracked and untracked files while files, missing and empty paths stay exact", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(PATH_MOVER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const root = fixture.root;
  await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "empty"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "deep", "new.ts"), "new\n");
  await fs.writeFile(path.join(root, "src", "build.log"), "ignored\n");
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, "src.ts"), "look-alike sibling\n");
  const repository = new WorkbenchGitRepository(root);

  assert.deepEqual(
    await expandGitArcClaimPaths(repository, ["src", "src.ts", "planned/new.rs", "empty"]),
    ["empty", "planned/new.rs", "src.ts", "src/deep/new.ts", "src/one.test.ts"],
  );
  await fs.unlink(path.join(root, "src", "one.test.ts"));
  assert.deepEqual(await expandGitArcClaimPaths(repository, ["src"]), ["src/deep/new.ts", "src/one.test.ts"], "deleted tracked files stay claimable");
});

test("folder moves claim each source file and its destination", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(PATH_MOVER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = new WorkbenchGitRepository(fixture.root);
  assert.deepEqual(await expandGitArcMoveClaimPaths(repository, [
    { source: "src", destination: "lib" },
    { source: "README.md", destination: "docs/README.md" },
  ]), ["docs/README.md", "lib/one.test.ts", "README.md", "src/one.test.ts"].sort((left, right) => left.localeCompare(right)));
});
