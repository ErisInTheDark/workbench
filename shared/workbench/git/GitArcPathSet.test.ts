/*
 * No production exports. Tests hold GitArcPathSet answers equal to the pairwise Git arc path rules it replaces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import GitArcPathSet from "./GitArcPathSet";

/** The pairwise rules the index replaced, kept here as its reference definition. */
function gitArcPathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
}

function gitArcPathsOverlap(left: string, right: string) {
  return gitArcPathIsCoveredBy(left, right) || gitArcPathIsCoveredBy(right, left);
}

const corpus = [
  ".", "a", "ab", "a-b", "a/b", "a/bc", "a/b/c", "a/b/c/d.ts", "a/b-c", "a.b", "b", "b/a", "z/a/b",
  "fixtures/x/.zlint", "fixtures/x/expected/diagnostics", "fixtures/xy/a.ts",
];

function memberSubsets() {
  return [
    [], ["."], ["a"], ["a/b"], ["a/b/c/d.ts"], ["ab", "a/bc"], ["a", "a/b", "a/b/c"], ["b/a", "a/b-c", "a.b"],
    ["fixtures/x"], ["fixtures/x/.zlint", "fixtures/xy/a.ts"], [...corpus],
  ];
}

test("index answers match the pairwise path rules for every corpus path", () => {
  for (const members of memberSubsets()) {
    const set = new GitArcPathSet(members);
    for (const path of corpus) {
      const label = `${JSON.stringify(members)} :: ${path}`;
      assert.equal(set.has(path), members.includes(path), `has ${label}`);
      const holding = members.filter(member => member !== path && gitArcPathIsCoveredBy(path, member));
      assert.equal(set.within(path), holding.length > 0, `within ${label}`);
      assert.deepEqual(new Set(set.holding(path)), new Set(holding), `holding ${label}`);
      assert.equal(set.covers(path), members.some(member => gitArcPathIsCoveredBy(path, member)), `covers ${label}`);
      assert.equal(set.contains(path), members.some(member => member.startsWith(`${path}/`)), `contains ${label}`);
      assert.equal(set.overlaps(path), members.some(member => gitArcPathsOverlap(path, member)), `overlaps ${label}`);
      assert.deepEqual(set.overlapping(path), members.filter(member => gitArcPathsOverlap(path, member)), `overlapping ${label}`);
    }
  }
});

test("incremental adds keep every index consistent", () => {
  const set = new GitArcPathSet(["a/b/c"]);
  assert.deepEqual(set.overlapping("a"), ["a/b/c"]);
  set.add("a/b/d");
  set.add("a/b/c");
  set.add("a");
  assert.equal(set.size, 3);
  assert.deepEqual(set.overlapping("a/b"), ["a/b/c", "a/b/d", "a"]);
  assert.equal(set.contains("a/b"), true);
  assert.equal(set.covers("a/zzz"), true);
  assert.equal(set.overlaps("ab"), false);
});
