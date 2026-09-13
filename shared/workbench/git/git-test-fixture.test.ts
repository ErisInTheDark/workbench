/*
 * No production exports. Tests protect single-use allocation across cache/direct consumers and manifest admission failures.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimPreparedGitTestFixture, GIT_TEST_FIXTURE_MANIFEST_ENV, gitTestFixtureKey } from "./git-test-fixture.ts";

const { default: GitTestFixtureCache } = createRequire(import.meta.url)(
  "../../../daemon/lib/workbench/git/GitTestFixtureCache.ts",
) as typeof import("../../../daemon/lib/workbench/git/GitTestFixtureCache");

test("prepared fixture consumers share single-use allocation and reject invalid admission", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-fixture-manifest-"));
  const previousManifest = process.env[GIT_TEST_FIXTURE_MANIFEST_ENV];
  context.after(async () => {
    if (previousManifest === undefined) delete process.env[GIT_TEST_FIXTURE_MANIFEST_ENV];
    else process.env[GIT_TEST_FIXTURE_MANIFEST_ENV] = previousManifest;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const spec = { name: "allocation", commits: [] };
  const slot = (name: string) => ({
    bundleRoot: path.join(root, name),
    root: path.join(root, name, "repo"),
    state: {},
    storageRootPath: path.join(root, name, "storage"),
    temporaryRoot: path.join(root, name),
  });
  const first = slot("first");
  const second = slot("second");
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    fixtures: {
      [path.basename(process.argv[1]!)]: { [gitTestFixtureKey(spec)]: [first, second] },
      "another.test.ts": { [gitTestFixtureKey({ ...spec, name: "other" })]: [slot("other")] },
    },
  }));
  process.env[GIT_TEST_FIXTURE_MANIFEST_ENV] = manifestPath;
  const cache = new GitTestFixtureCache();
  const [fromCache, direct] = await Promise.all([cache.copy(spec), claimPreparedGitTestFixture(spec)]);
  assert.deepEqual(new Set([fromCache.root, direct.root]), new Set([first.root, second.root]));
  await assert.rejects(cache.copy(spec));
  await assert.rejects(claimPreparedGitTestFixture(spec));
  await assert.rejects(claimPreparedGitTestFixture({ ...spec, name: "other" }));
  await fromCache.dispose();
  await direct.dispose();

  const malformedPath = path.join(root, "malformed.json");
  await fs.writeFile(malformedPath, JSON.stringify({ version: 2, fixtures: {} }));
  process.env[GIT_TEST_FIXTURE_MANIFEST_ENV] = malformedPath;
  await assert.rejects(claimPreparedGitTestFixture(spec));
  await assert.rejects(cache.copy(spec));
  delete process.env[GIT_TEST_FIXTURE_MANIFEST_ENV];
  await assert.rejects(claimPreparedGitTestFixture(spec));
});
