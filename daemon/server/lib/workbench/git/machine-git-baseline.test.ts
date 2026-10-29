/*
 * No production exports. Tests cover machine baseline absorption: unowned requested paths take disk content as HEAD,
 * while owned and adopted work never moves with HEAD; and known paths shrink to what arcs still reference.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import type { GitArcRegistryEntry } from "./GitArcRegistry";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { absorbMachineBaseline } from "./machine-git-baseline";
import { ensureMachineGitWorktree } from "./machine-git-worktrees";

async function headText(repository: WorkbenchGitRepository, filePath: string) {
  const file = (await repository.readTreeFiles("HEAD", [filePath])).get(filePath);
  return file ? file.bytes.toString("utf8") : null;
}

test("absorption takes unowned disk content and leaves owned and adopted work as changes", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-machine-baseline-");
  context.after(async () => await temporary.dispose());
  const drive = path.join(temporary.path, "drive");
  await fs.mkdir(drive, { recursive: true });
  const write = async (filePath: string, text: string) => await fs.writeFile(path.join(drive, filePath), text, "utf8");
  await write("owned.txt", "v1\n");
  await write("external.txt", "v1\n");
  await ensureMachineGitWorktree(drive, path.join(temporary.path, "machine-git"));
  const repository = new WorkbenchGitRepository(drive);
  const root = await repository.headOrNull();
  const tracked = await repository.createCommitFromTree(await repository.writeScopedWorktreeTree(["owned.txt", "external.txt"], root), root, "tracked\n");
  await repository.updateRefs([{ ref: await repository.symbolicHead() ?? "HEAD", newValue: tracked, oldValue: root }]);

  await write("owned.txt", "agent work\n");
  await write("external.txt", "user edit\n");
  await write("existing.txt", "original\n");
  await write("adopted.txt", "made by a command\n");
  const owner: GitArcRegistryEntry = {
    checkpointCommit: tracked, claimedPaths: ["owned.txt"], harness: "codex", intentDescription: "", intentName: "Owner",
    phase: "active", threadId: "owner", updatedAt: "",
  };
  const request = { paths: ["adopted.txt", "existing.txt", "external.txt", "owned.txt"], adoptPaths: ["adopted.txt"] };

  assert.deepEqual(await absorbMachineBaseline(repository, [owner], request), ["existing.txt", "external.txt"]);
  assert.equal(await headText(repository, "existing.txt"), "original\n");
  assert.equal(await headText(repository, "external.txt"), "user edit\n");
  assert.equal(await headText(repository, "owned.txt"), "v1\n");
  assert.equal(await headText(repository, "adopted.txt"), null);
  assert.deepEqual(await repository.listWorktreeChangedPaths("HEAD", request.paths), ["adopted.txt", "owned.txt"]);

  const head = await repository.headOrNull();
  assert.deepEqual(await absorbMachineBaseline(repository, [owner], request), []);
  assert.equal(await repository.headOrNull(), head);
});

test("whole-worktree snapshots stop walking requested paths no arc references any more", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-machine-baseline-");
  context.after(async () => await temporary.dispose());
  const drive = path.join(temporary.path, "drive");
  await fs.mkdir(path.join(drive, "store"), { recursive: true });
  await ensureMachineGitWorktree(drive, path.join(temporary.path, "machine-git"));
  const repository = new WorkbenchGitRepository(drive);
  const owner: GitArcRegistryEntry = {
    checkpointCommit: "0".repeat(40), claimedPaths: ["store"], harness: "codex", intentDescription: "", intentName: "Owner",
    phase: "active", threadId: "owner", updatedAt: "",
  };
  await absorbMachineBaseline(repository, [owner], { paths: ["store"], adoptPaths: [] });
  await fs.writeFile(path.join(drive, "store", "blob.bin"), "backup\n", "utf8");
  await fs.writeFile(path.join(drive, "other.txt"), "other\n", "utf8");
  const snapshotPaths = async () => {
    const { head, tree } = await repository.writeWorktreeSnapshot();
    return await repository.listAllChangedPaths(head, tree);
  };

  await absorbMachineBaseline(repository, [owner], { paths: ["other.txt"], adoptPaths: [] });
  assert.deepEqual(await snapshotPaths(), ["store/blob.bin"]);
  await absorbMachineBaseline(repository, [{ ...owner, claimedPaths: [], phase: "resolved" }], { paths: ["other.txt"], adoptPaths: [] });
  assert.deepEqual(await snapshotPaths(), []);
});
