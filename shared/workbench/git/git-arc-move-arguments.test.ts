/*
 * Keywords: Git arc, move arguments, typed rejections.
 * Exports: none. Protect move grammar and its failure reasons.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseGitArcMoveArguments } from "./git-arc-move-arguments.ts";

test("arc mv parses familiar operands and repeated explicit mappings", () => {
  assert.deepEqual(parseGitArcMoveArguments(["old.ts", "new.ts"]), {
    kind: "operands",
    operands: ["old.ts", "new.ts"],
  });
  assert.deepEqual(parseGitArcMoveArguments(["--", "one.ts", "two.ts", "target"]), {
    kind: "operands",
    operands: ["one.ts", "two.ts", "target"],
  });
  assert.deepEqual(parseGitArcMoveArguments([
    "--map", "old-a.ts", "new-a.ts",
    "--map", "old-b.ts", "new-b.ts",
  ]), {
    kind: "maps",
    mappings: [
      { destination: "new-a.ts", source: "old-a.ts" },
      { destination: "new-b.ts", source: "old-b.ts" },
    ],
  });
});

test("arc mv parses stateless regex preview and confirmation", () => {
  assert.deepEqual(parseGitArcMoveArguments([
    "--regex", String.raw`^webapp/(?!tests/)(.+\.test\.tsx?)$`,
    "--replace", "webapp/tests/$1",
    "--", "webapp",
  ]), {
    confirm: false,
    kind: "regex",
    pattern: String.raw`^webapp/(?!tests/)(.+\.test\.tsx?)$`,
    replacement: "webapp/tests/$1",
    roots: ["webapp"],
  });
  assert.equal(parseGitArcMoveArguments([
    "--confirm", "--regex", "^src/(.+)$", "--replace", "tests/$1", "--", "src",
  ]).kind, "regex");
  assert.equal((parseGitArcMoveArguments([
    "--confirm", "--regex", "^src/(.+)$", "--replace", "tests/$1", "--", "src",
  ]) as { confirm: boolean }).confirm, true);
});

test("arc mv rejects mixed and incomplete grammars", () => {
  assert.throws(() => parseGitArcMoveArguments(["only-source.ts"]), /source and one destination/u);
  assert.throws(() => parseGitArcMoveArguments(["--map", "old.ts"]), /requires a value/u);
  assert.throws(() => parseGitArcMoveArguments(["--regex", "x", "--", "src"]), /both --regex and --replace/u);
  assert.throws(() => parseGitArcMoveArguments(["--regex", "x", "--replace", "y"]), /search root/u);
  assert.throws(() => parseGitArcMoveArguments(["--map", "old.ts", "new.ts", "extra.ts"]), (error) => {
    assert.ok(error instanceof Error && "rejection" in error);
    assert.deepEqual(error.rejection, { reason: "mixedMoveForms" });
    return true;
  });
});
