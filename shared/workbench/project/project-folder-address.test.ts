/*
 * No production exports. Protect folder suffixes staying unique per daemon, not across daemons, and folders ordering by
 * their newest thread launch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { ProjectFolderAddress, ProjectFolderOption } from "./project-folder-address";

const server = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const desktop = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const folder = (daemonId: typeof server, rootPath: string) =>
  ({ target: { daemonId, projectId: ProjectIdSchema.parse(rootPath.replace(/\W/gu, "-")) }, rootPath });

test("suffixes grow only past same-daemon collisions and mark worktrees", () => {
  const suffixes = ProjectFolderAddress.suffixes([
    folder(server, "/srv/a/workbench"),
    folder(server, "/srv/b/workbench"),
    folder(server, "/srv/a/workbench/.workbench/worktrees/fix"),
    folder(desktop, "C:\\git\\web\\workbench"),
  ]).map(parts => parts.join("/"));
  assert.deepEqual(suffixes, ["a/workbench", "b/workbench", "+fix", "workbench"]);
});

test("folders order by their newest launch, unlaunched folders keep their order below", () => {
  const folders = ["/a", "/b", "/c", "/d", "/e"].map(rootPath => folder(server, rootPath));
  const launch = (index: number, revision: number) => ({ target: folders[index]!.target, revision });
  const ordered = ProjectFolderOption.byRecentLaunch(folders, [
    launch(3, 4),
    launch(1, 9),
    launch(3, 12),
  ]).map(item => item.rootPath);
  assert.deepEqual(ordered, ["/d", "/b", "/a", "/c", "/e"]);
});
