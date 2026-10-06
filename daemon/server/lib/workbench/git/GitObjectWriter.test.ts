/*
 * No production exports. Equivalence wards: in-process objects must be byte-identical to Git's own, in SHA-1 and SHA-256 stores.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import GitObjectReadSession from "./GitObjectReadSession";
import GitObjectWriter from "./GitObjectWriter";

const execFileAsync = promisify(execFile);

async function repository(format: "sha1" | "sha256") {
  const directory = await WorkbenchTemporaryDirectory.create(`workbench-object-writer-${format}-`);
  const git = async (args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) => {
    const child = execFileAsync("git", args, { cwd: directory.path, encoding: "utf8", env, windowsHide: true });
    if (input !== undefined) child.child.stdin!.end(input);
    return (await child).stdout.trim();
  };
  await git(["init", "-q", `--object-format=${format}`]);
  await git(["config", "user.name", "Object Writer"]);
  await git(["config", "user.email", "writer@example.com"]);
  return { directory, git, writer: new GitObjectWriter(directory.path) };
}

for (const format of ["sha1", "sha256"] as const) {
  test(`${format} blobs, trees and commits match the objects Git writes`, async (context) => {
    const { directory, git, writer } = await repository(format);
    context.after(() => directory.dispose());
    await GitObjectReadSession.run(async () => {
      const contents = "nul\0 bytes, λ and no trailing newline";
      const blob = await writer.writeObject("blob", Buffer.from(contents, "utf8"));
      assert.equal(blob, await git(["hash-object", "--stdin"], contents));
      const tree = await git(["mktree"], `100644 blob ${blob}\tfile.txt\n`);
      const date = "1759633402 +1300";
      const dated = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      const root = await writer.writeCommit(tree, [], "root\n", { authorDate: date, committerDate: date });
      assert.equal(root, await git(["commit-tree", tree, "--no-gpg-sign", "-F", "-"], "root\n", dated));
      const side = await git(["commit-tree", tree, "--no-gpg-sign", "-F", "-"], "side\n", dated);
      for (const message of ["", "no newline", "  leading space\n\n\n# not a comment\n\n", "title\n\nbody ✓\n"]) {
        const commit = await writer.writeCommit(tree, [root!, side], message, {
          authorDate: date, authorName: "Someone Else", authorEmail: "else@example.com", committerDate: "1759633999 -0230",
        });
        assert.equal(commit, await git(["commit-tree", tree, "--no-gpg-sign", "-p", root!, "-p", side, "-F", "-"], message, {
          ...process.env,
          GIT_AUTHOR_DATE: date, GIT_AUTHOR_EMAIL: "else@example.com", GIT_AUTHOR_NAME: "Someone Else",
          GIT_COMMITTER_DATE: "1759633999 -0230",
        }), JSON.stringify(message));
      }
      // Inputs Git would rewrite or reject are left to Git.
      assert.equal(await writer.writeCommit(tree, [], "x\n", { authorDate: "2026-10-06T04:05:47Z" }), null);
      assert.equal(await writer.writeCommit(tree, [], "x\n", { authorName: " padded " }), null);
      assert.equal(await writer.writeCommit(tree, [blob], "x\n"), null);
    });
    await git(["fsck", "--strict", "--no-dangling"]);
  });
}
