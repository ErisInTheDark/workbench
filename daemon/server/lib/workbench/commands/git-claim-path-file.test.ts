/*
 * Exports: none. Protect bounded, project-contained bulk claim input.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { readGitClaimPathFile } from "./git-claim-path-file";

test("reads strict claim arrays from a project-contained JSON file", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-claim-paths-");
  context.after(async () => await temporary.dispose());
  const root = temporary.path;
  await fs.writeFile(path.join(root, "claims.json"), JSON.stringify({
    addPaths: ["fixtures/a.ts", "fixtures/b.ts"],
    adoptPaths: [],
    removePaths: ["fixtures/old.ts"],
    roots: [],
  }));

  assert.deepEqual(await readGitClaimPathFile(root, "claims.json"), {
    addPaths: ["fixtures/a.ts", "fixtures/b.ts"],
    adoptPaths: [],
    removePaths: ["fixtures/old.ts"],
    roots: [],
  });
  await fs.writeFile(path.join(root, "extra.json"), JSON.stringify({
    addPaths: [], adoptPaths: [], removePaths: [], roots: [], surprise: true,
  }));
  await assert.rejects(readGitClaimPathFile(root, "extra.json"), /unrecognized|surprise/iu);
  await assert.rejects(readGitClaimPathFile(root, "../outside.json"), /inside|beneath|project/iu);
});
