/*
 * Exports: none.
 * Tests: project creation seeds templates and Git, refuses folders discovery cannot reach, removes failed creations, and lists only folders.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { initGitRepository } from "./lib/git";
import WorkbenchProjectCreationController from "./WorkbenchProjectCreationController";

async function fixture(initRepository?: (rootDir: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wb-project-create-")));
  const discovered: string[] = [];
  const controller = new WorkbenchProjectCreationController({
    catalog: {
      readDiscoverySettings: async () => ({ paths: [root] }),
      discoverCreatedProject: async projectPath => {
        discovered.push(projectPath);
        return ProjectIdSchema.parse(path.basename(projectPath));
      },
    },
    ...(initRepository ? { initRepository } : {}),
  });
  return { root, discovered, controller, [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }) };
}

const exists = async (target: string) => await fs.stat(target).then(() => true, () => false);

test("node template creates a discovered repository with only an npm-safe package.json", async () => {
  await using env = await fixture();
  const result = await env.controller.create({ parentPath: env.root, name: "My Thing", template: "node" });
  const projectPath = path.join(env.root, "My Thing");
  assert.deepEqual(result, { accepted: true, path: projectPath, projectId: "My Thing" });
  assert.deepEqual(env.discovered, [projectPath]);
  assert.equal(await exists(path.join(projectPath, ".git")), true);
  assert.deepEqual((await fs.readdir(projectPath)).sort(), [".git", "package.json"]);
  const manifest = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf8"));
  assert.equal(manifest.name, "my-thing");
});

test("none template creates an otherwise empty repository", async () => {
  await using env = await fixture();
  const result = await env.controller.create({ parentPath: env.root, name: "plain", template: "none" });
  assert.equal(result.accepted, true);
  assert.deepEqual(await fs.readdir(path.join(env.root, "plain")), [".git"]);
});

test("creation refuses names, parents and targets discovery could not own", async () => {
  await using env = await fixture();
  await fs.mkdir(path.join(env.root, "taken"));
  await fs.mkdir(path.join(env.root, "repo", "nested"), { recursive: true });
  await initGitRepository(path.join(env.root, "repo"));
  const outside = path.dirname(env.root);
  const cases = [
    [{ parentPath: env.root, name: "bad/name" }, "invalid-name"],
    [{ parentPath: env.root, name: "taken" }, "exists"],
    [{ parentPath: path.join(env.root, "missing"), name: "x" }, "parent-missing"],
    [{ parentPath: outside, name: `wb-outside-${Date.now()}` }, "outside-roots"],
    [{ parentPath: path.join(env.root, "repo", "nested"), name: "x" }, "inside-project"],
  ] as const;
  for (const [request, reason] of cases) {
    assert.deepEqual(await env.controller.create({ ...request, template: "node" }), { accepted: false, reason }, reason);
  }
  assert.deepEqual(env.discovered, []);
  assert.equal(await exists(path.join(env.root, "repo", "nested", "x")), false);
});

test("a failed repository initialisation removes the new folder and surfaces the failure", async () => {
  await using env = await fixture(async () => { throw new Error("git unavailable"); });
  await assert.rejects(env.controller.create({ parentPath: env.root, name: "doomed", template: "node" }), /git unavailable/u);
  assert.equal(await exists(path.join(env.root, "doomed")), false);
  assert.deepEqual(env.discovered, []);
});

test("folder listings contain only sorted folders and flag repositories", async () => {
  await using env = await fixture();
  await fs.mkdir(path.join(env.root, "b-repo"));
  await initGitRepository(path.join(env.root, "b-repo"));
  await fs.mkdir(path.join(env.root, "a-folder"));
  await fs.writeFile(path.join(env.root, "file.txt"), "");
  const listing = await env.controller.listFolders(env.root);
  assert.equal(listing.parentPath, path.dirname(env.root));
  assert.deepEqual(listing.entries.map(entry => [entry.name, entry.isGitRepository]), [["a-folder", false], ["b-repo", true]]);
  assert.equal(listing.truncated, false);
});
