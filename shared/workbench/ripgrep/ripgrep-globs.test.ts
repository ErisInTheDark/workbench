/*
 * No production exports. Tests protect rg glob semantics: braces, classes, ** at any depth, anchoring, later-wins negation,
 * file types, and directory pruning that never hides a file the filter keeps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRipgrepDirectoryPruner, createRipgrepPathFilter } from "./ripgrep-globs";

function specs(globs: string[]) {
  return globs.map(glob => ({ glob, caseInsensitive: false }));
}

function filter(globs: string[], types: string[] = [], typesNot: string[] = []) {
  return createRipgrepPathFilter({ globs: specs(globs), types, typesNot });
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

test("negated globs prune directories they fully cover, unless a later include could re-admit a file", () => {
  const prunes = (globs: string[], directory: string) => createRipgrepDirectoryPruner(specs(globs))(directory);
  assert.equal(prunes(["!**/node_modules/**"], "scratch/a/node_modules"), true);
  assert.equal(prunes(["!node_modules"], "a/node_modules"), true);
  assert.equal(prunes(["!build/"], "pkg/build"), true);
  assert.equal(prunes(["!node_modules/**"], "a/node_modules"), false, "an anchored glob covers only the cwd's node_modules");
  assert.equal(prunes(["!**/node_modules/**"], "scratch/node_modules_old"), false);
  assert.equal(prunes(["!*.jsonl"], "logs"), false);
  assert.equal(prunes(["!**/node_modules/**", "*.md"], "a/node_modules"), false, "a later name glob can re-admit at any depth");
  assert.equal(prunes(["*.md", "!**/node_modules/**"], "a/node_modules"), true);
});

test("a later anchored include only keeps the directories it can reach", () => {
  const prunes = (globs: string[], directory: string) => createRipgrepDirectoryPruner(specs(globs))(directory);
  assert.equal(prunes(["!**/node_modules/**", "src/**"], "scratch/node_modules"), true);
  assert.equal(prunes(["!**/node_modules/**", "src/**"], "src/node_modules"), false);
  assert.equal(prunes(["src/**"], "fixtures"), true, "when no include can reach a directory, nothing beneath is admitted");
  assert.equal(prunes(["src/**"], "src"), false);
  assert.equal(prunes(["src/*.ts"], "src/deep"), true);
  assert.equal(prunes(["src/*.ts"], "src/deep.ts"), false, "a directory can carry a matching name");
  assert.equal(prunes(["**/x/*.md"], "a/b"), false);
  assert.equal(prunes(["{src,lib/gen}/**"], "fixtures"), false, "a glob that cannot split into segments never prunes");
});

test("a pruned directory never hides a file the path filter would have kept", () => {
  const globSets = [
    ["!**/node_modules/**"], ["!node_modules"], ["!build/"], ["!**/gen/*"], ["!a/{,x}"], ["!**/b?"], ["!*.d"], ["!**"],
    ["*.ts", "!**/vendor/**"], ["!**/vendor/**", "vendor/keep.ts"], ["!**/node_modules/**", "*.md"],
    ["src/**"], ["src/*.ts"], ["src/**/a.ts"], ["**/x/*.md"], ["a/*/x/**"], ["!**/node_modules/**", "src/**"],
    ["src/**", "!src/gen/**"], ["!src/**", "src/keep.ts"], ["deep.ts/"], ["x/**", "!**", "a/**/*.md"], ["{src,a}/**"],
    ["s?c/**"], ["[ab]/**"], ["src/[!x]*/**"],
  ];
  const names = ["src", "a", "node_modules", "x", "deep.ts", "b1", "gen", "vendor", "sxc"];
  const directories = names.flatMap(first => [first, ...names.flatMap(second => [
    `${first}/${second}`, ...names.map(third => `${first}/${second}/${third}`),
  ])]);
  const children = ["a.ts", "b.md", "keep.ts", "x/a.ts", "deep/f.md", "1", "gen/q.ts", "node_modules/p.js", "x/y/z.md"];
  let pruned = 0;
  for (const globs of globSets) {
    const prune = createRipgrepDirectoryPruner(specs(globs));
    const keeps = filter(globs);
    for (const directory of directories) {
      if (!prune(directory)) continue;
      pruned += 1;
      for (const child of children) {
        assert.equal(keeps(`${directory}/${child}`), false, `${globs.join(" ")} pruned ${directory} but keeps ${directory}/${child}`);
      }
    }
  }
  assert.ok(pruned > directories.length, "the sweep exercises real pruning, not only refusals");
});

test("file types include and exclude by name pattern", () => {
  assert.equal(filter([], ["ts"])("a.mts"), true);
  assert.equal(filter([], ["ts"])("a.js"), false);
  assert.equal(filter([], [], ["md"])("docs/README.md"), false);
  assert.equal(filter([], [], ["md"])("docs/a.ts"), true);
});
