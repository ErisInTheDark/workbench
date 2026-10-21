/*
 * No production exports. Tests protect complete, non-overlapping premise and dedicated-test line totals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeGitArcChanges } from "./git-arc-change-totals.ts";

test("mixed changes partition every line exactly once, including inline rust tests as premise", () => {
  const changes = [
    { path: "src/owner.ts", additions: 24, deletions: 8 },
    { path: "src/owner.test.ts", additions: 90, deletions: 12 },
    { path: "src/lib.rs", additions: 3, deletions: 2 },
    { path: "repo/cache_test.go", additions: 0, deletions: 7 },
    { path: "tests/test_cache.py", additions: 4, deletions: 0 },
    { path: "image.png", additions: 0, deletions: 0 },
  ];
  const result = summarizeGitArcChanges(changes);
  assert.deepEqual(result, {
    files: 6,
    premise: { additions: 27, deletions: 10 },
    tests: { additions: 94, deletions: 19 },
  });
  for (const count of ["additions", "deletions"] as const) {
    assert.equal(result.premise[count] + result.tests[count], changes.reduce((sum, change) => sum + change[count], 0));
  }
});

test("test-only and premise-only changes stay in their own partition", () => {
  assert.deepEqual(summarizeGitArcChanges([
    { path: "owner.spec.tsx", additions: 8, deletions: 3 },
    { path: "CacheTest.java", additions: 0, deletions: 2 },
  ]), {
    files: 2,
    premise: { additions: 0, deletions: 0 },
    tests: { additions: 8, deletions: 5 },
  });
  assert.deepEqual(summarizeGitArcChanges([
    { path: "tests/owner.rs", additions: 5, deletions: 0 },
    { path: "src/owner.test.fixtures.ts", additions: 0, deletions: 4 },
  ]), {
    files: 2,
    premise: { additions: 5, deletions: 4 },
    tests: { additions: 0, deletions: 0 },
  });
});

test("empty and zero-line changes do not manufacture counts", () => {
  assert.deepEqual(summarizeGitArcChanges([]), {
    files: 0, premise: { additions: 0, deletions: 0 }, tests: { additions: 0, deletions: 0 },
  });
  assert.deepEqual(summarizeGitArcChanges([{ path: "owner.test.ts", additions: 0, deletions: 0 }]), {
    files: 1, premise: { additions: 0, deletions: 0 }, tests: { additions: 0, deletions: 0 },
  });
});
