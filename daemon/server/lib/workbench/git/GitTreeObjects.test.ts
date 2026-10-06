/*
 * No production exports. Equivalence wards: in-process tree diffs and path surgery must match Git's diff and index surgery.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import GitObjectReadSession from "./GitObjectReadSession";
import GitObjectWriter from "./GitObjectWriter";
import GitTreeObjects, { type GitTreeEdit } from "./GitTreeObjects";

const execFileAsync = promisify(execFile);

for (const format of ["sha1", "sha256"] as const) {
  test(`${format} tree diffs and path surgery match Git across swaps, modes and gitlinks`, async (context) => {
    const directory = await WorkbenchTemporaryDirectory.create(`workbench-tree-objects-${format}-`);
    context.after(() => directory.dispose());
    const root = directory.path;
    const git = async (args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) => {
      const child = execFileAsync("git", args, { cwd: root, encoding: "utf8", env, windowsHide: true });
      if (input !== undefined) child.child.stdin!.end(input);
      return (await child).stdout;
    };
    const write = async (file: string, contents: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), contents);
    };
    await git(["init", "-q", `--object-format=${format}`]);
    for (const [file, contents] of Object.entries({
      "a": "a\n", "a.b": "a.b\n", "same/deep/keep.txt": "keep\n", "same.txt": "sorts before same/\n", "modify.txt": "before\n", "delete.txt": "gone\n",
      "mode.sh": "echo\n", "becomes-dir": "file\n", "becomes-file/inner.txt": "inner\n", "d/x.txt": "x\n", "d/y.txt": "y\n",
    })) await write(file, contents);
    await git(["add", "-A"]);
    const left = (await git(["write-tree"])).trim();
    await write("modify.txt", "after\n");
    await fs.rm(path.join(root, "delete.txt"));
    await fs.rm(path.join(root, "becomes-dir"));
    await write("becomes-dir/now.txt", "now\n");
    await fs.rm(path.join(root, "becomes-file"), { recursive: true });
    await write("becomes-file", "flat\n");
    await write("d/z.txt", "z\n");
    await write("added/new.txt", "new\n");
    await git(["add", "-A"]);
    await git(["update-index", "--chmod=+x", "mode.sh"]);
    const commitLike = (await git(["rev-parse", left])).trim();
    await git(["update-index", "--add", "--cacheinfo", `160000,${commitLike},gitlink`]);
    const right = (await git(["write-tree"])).trim();

    const trees = new GitTreeObjects(root, new GitObjectWriter(root));
    const expectedChanged = (await git(["diff", "--name-only", "-z", "--no-renames", left, right])).split("\0").filter(Boolean).sort();
    await GitObjectReadSession.run(async () => {
      assert.deepEqual((await trees.changedPaths(left, right)).sort(), expectedChanged);
      assert.deepEqual((await trees.changedPaths(right, left)).sort(), expectedChanged);
      assert.deepEqual(await trees.changedPaths(left, left), []);
      // Git's own index plumbing is the oracle: absent paths are removed, present ones take the source's mode and object.
      const sourceEntries = new Map((await git(["ls-tree", "-r", "-z", "--full-tree", right])).split("\0").filter(Boolean).map(line => {
        const [meta = "", file = ""] = line.split("\t");
        const [mode = "", , id = ""] = meta.split(" ");
        return [file, { id, mode }];
      }));
      const surgeryIndex = path.join(root, ".git", "surgery-index");
      for (const selected of [expectedChanged, expectedChanged.filter(file => /^(becomes|d\/|mode|gitlink|delete)/u.test(file))]) {
        const env = { ...process.env, GIT_INDEX_FILE: surgeryIndex };
        await git(["read-tree", left], undefined, env);
        const zero = "0".repeat(left.length);
        const removals = selected.filter(file => !sourceEntries.has(file)).map(file => `0 ${zero}\t${file}\n`);
        const additions = selected.flatMap(file => sourceEntries.has(file) ? [`${sourceEntries.get(file)!.mode} ${sourceEntries.get(file)!.id}\t${file}\n`] : []);
        await git(["update-index", "--replace", "--index-info"], [...removals, ...additions].join(""), env);
        const expected = (await git(["write-tree"], undefined, env)).trim();
        const edits = new Map<string, GitTreeEdit>(await trees.entriesAt(right, selected));
        assert.equal(await trees.withEdits(left, edits), expected, selected.join(","));
      }
      assert.equal(await trees.withEdits(null, new Map()), (await git(["mktree"], "")).trim());
    });
    await git(["fsck", "--strict", "--no-dangling"]);
  });
}
