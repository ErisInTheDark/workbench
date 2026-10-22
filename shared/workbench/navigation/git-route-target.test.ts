/* No production exports. Protect git tab targets round-tripping through tab segments and rejecting what is not a target. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchGitTarget } from "./git-route-target";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("targets round-trip with and without a folder or file", () => {
  for (const target of [
    { folderAddress: null, object: WorkbenchGitTarget.changes, path: null },
    { folderAddress: ["daemon", "+lab"], object: { kind: "stash" as const, sha }, path: null },
    { folderAddress: ["repo"], object: { kind: "commit" as const, sha }, path: "src/deep/file name.ts" },
  ]) {
    const segments = WorkbenchGitTarget.format(target, "*").split("/").map(decodeURIComponent);
    assert.deepEqual(WorkbenchGitTarget.parse(segments, "*"), target);
  }
});

test("malformed targets parse to nothing instead of a guessed object", () => {
  for (const segments of [[], ["commit"], ["commit", "HEAD"], ["stash", "abc"], ["*", "changes"], ["branch", "main"]]) {
    assert.equal(WorkbenchGitTarget.parse(segments, "*"), null);
  }
});
