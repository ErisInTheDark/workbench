/* Exports: none; protect demanded history refresh and watched-checkout cleanup. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { GitPeerCommits } from "workbench-shared/workbench/git/git-peer-contracts";
import WorkbenchBranchPositionController from "./WorkbenchBranchPositionController";
import WorkbenchGitPeerTransport from "./lib/workbench/git/WorkbenchGitPeerTransport";

test("history demand refreshes on ref changes and released readers ignore late results", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("branch-preview-");
  t.after(() => temporary.dispose());
  await promisify(execFile)("git", ["init", "-b", "main"], { cwd: temporary.path, windowsHide: true });
  const watched = Promise.withResolvers<() => void>();
  let stops = 0;
  let result = Promise.withResolvers<GitPeerCommits>();
  let started = Promise.withResolvers<void>();
  const warnings: string[] = [];
  t.mock.method(WorkbenchGitPeerTransport.prototype, "commits", () => {
    started.resolve();
    return result.promise;
  });
  const owner = new WorkbenchBranchPositionController({
    resolveRoot: async () => temporary.path,
    warn: message => warnings.push(message),
    watch: async (_directories, _names, changed) => {
      watched.resolve(changed);
      return () => { stops++; };
    },
  });
  t.after(() => owner.dispose());
  let notifications = 0;
  let changed = Promise.withResolvers<void>();
  const handle = owner.observeCommits("project", {
    peer: { daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-00000000000a"), projectId: ProjectIdSchema.parse("peer") },
    branch: "main", action: "pull", all: false,
  }, () => { notifications++; changed.resolve(); });
  await started.promise;
  const refresh = await watched.promise;
  const first: GitPeerCommits = { branch: "main", head: "a".repeat(40), tip: "b".repeat(40), total: 1,
    commits: [{ commit: "b".repeat(40), subject: "first" }] };
  result.resolve(first);
  await changed.promise;
  assert.deepEqual(handle.read().data, first);
  result = Promise.withResolvers<GitPeerCommits>();
  started = Promise.withResolvers<void>();
  changed = Promise.withResolvers<void>();
  refresh();
  await started.promise;
  const second = { ...first, tip: "c".repeat(40), commits: [{ commit: "c".repeat(40), subject: "replacement" }] };
  result.resolve(second);
  await changed.promise;
  assert.deepEqual(handle.read().data, second);
  result = Promise.withResolvers<GitPeerCommits>();
  started = Promise.withResolvers<void>();
  changed = Promise.withResolvers<void>();
  refresh();
  await started.promise;
  result.reject(new Error("history temporarily unavailable"));
  await changed.promise;
  assert.equal(handle.read().phase, "stale");
  assert.deepEqual(handle.read().data, second);
  assert.equal(warnings.length, 1);
  result = Promise.withResolvers<GitPeerCommits>();
  started = Promise.withResolvers<void>();
  refresh();
  await started.promise;
  handle.release();
  assert.equal(stops, 1);
  result.resolve(first);
  await result.promise;
  await Promise.resolve();
  assert.equal(notifications, 3);
  assert.deepEqual(handle.read().data, second);
});
