/* No production exports. Wards that folder claims become the Git-visible files they hold. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { expandGitArcClaimPaths } from "./git-arc-claim-expansion.ts";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import { SRC_BASE_FIXTURE } from "./WorkbenchGitTestFixtures.ts";

test("folders expand to their tracked and untracked files while files, missing and empty paths stay exact", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(SRC_BASE_FIXTURE);
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

test("links and junctions are claimed as themselves, never as the files behind them", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(SRC_BASE_FIXTURE);
  context.after(fixture.dispose);
  const root = fixture.root;
  const target = path.join(root, "target");
  await fs.mkdir(path.join(target, "album"), { recursive: true });
  await fs.writeFile(path.join(target, "album", "track.flac"), "music\n");
  await fs.mkdir(path.join(root, "music"), { recursive: true });
  await fs.writeFile(path.join(root, "music", "own.txt"), "own\n");
  // Git for Windows walks junctions as plain directories; Workbench must not.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(target, path.join(root, "music", "linked"), linkType);
  await fs.symlink(target, path.join(root, "top-link"), linkType);
  const repository = new WorkbenchGitRepository(root);

  assert.deepEqual(await expandGitArcClaimPaths(repository, ["top-link"]), ["top-link"]);
  assert.deepEqual(await expandGitArcClaimPaths(repository, ["music"]), ["music/linked", "music/own.txt"]);
});
