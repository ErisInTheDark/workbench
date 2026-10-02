/* No production exports. Tests protect rg glob semantics: braces, classes, ** at any depth, anchoring, later-wins negation and file types. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRipgrepPathFilter } from "./ripgrep-globs";

function filter(globs: string[], types: string[] = [], typesNot: string[] = []) {
  return createRipgrepPathFilter({ globs: globs.map(glob => ({ glob, caseInsensitive: false })), types, typesNot });
}

test("braces and classes expand like rg globs", () => {
  const matches = filter(["*.{ts,tsx}", "file[0-9].txt"]);
  assert.equal(matches("src/a.tsx"), true);
  assert.equal(matches("a.js"), false);
  assert.equal(matches("notes/file7.txt"), true);
  assert.equal(matches("notes/fileX.txt"), false);
});

test("**/ matches at the root and at depth, and later globs win", () => {
  const excluded = filter(["*.ts", "!**/generated/**"]);
  assert.equal(excluded("src/a.ts"), true);
  assert.equal(excluded("generated/b.ts"), false);
  assert.equal(excluded("x/generated/c.ts"), false);
  assert.equal(filter(["!**/generated/**", "generated/keep.ts"])("generated/keep.ts"), true);
});

test("globs with a slash anchor to cwd while bare names match any depth", () => {
  const anchored = filter(["src/*.ts"]);
  assert.equal(anchored("src/a.ts"), true);
  assert.equal(anchored("lib/src/a.ts"), false);
  assert.equal(filter(["a.ts"])("lib/src/a.ts"), true);
  assert.equal(filter(["!node_modules"])("node_modules/pkg/index.js"), false);
});

test("file types include and exclude by name pattern", () => {
  assert.equal(filter([], ["ts"])("a.mts"), true);
  assert.equal(filter([], ["ts"])("a.js"), false);
  assert.equal(filter([], [], ["md"])("docs/README.md"), false);
  assert.equal(filter([], [], ["md"])("docs/a.ts"), true);
});
