/*
 * No production exports. Tests protect dedicated-test filename classification without directory or source guesses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDedicatedTestFile } from "./dedicated-test-files";

test("dedicated test conventions classify across languages and path separators", () => {
  const paths = [
    "src/owner.test.ts", "src/owner.spec.tsx", "owner.test.js", "owner.spec.jsx",
    "owner.test.mjs", "owner.spec.cjs", "owner.test.mts", "owner.spec.cts",
    "owner.spec.vue", "owner.test.svelte", "owner.test.rs", "owner.spec.rs",
    "repo/cache_test.go", "tests/test_cache.py", "src/test_helpers.py", "cache_test.py",
    "cache_test.rb", "cache_spec.rb", "cache_test.dart", "cache_test.exs",
    "cache_test.clj", "cache_test.cljs", "cache_test.cljc",
    "CacheTest.java", "CacheTests.java", "CacheTestCase.java",
    "CacheTest.kt", "CacheTests.kt", "CacheTest.cs", "CacheTests.cs",
    "CacheTests.swift", "CacheTest.php", "CacheTest.scala", "CacheSpec.scala",
    "C:\\repo\\owner.test.ts", "C:\\repo\\test_cache.py",
  ];
  for (const path of paths) assert.equal(isDedicatedTestFile(path), true, path);
});

test("ordinary source and test-looking directories do not become dedicated test files", () => {
  for (const path of [
    "src/lib.rs", "tests/cache.rs", "tests/cache.ts", "tests/cache.py",
    "src/test_helpers.ts", "src/cache.test.fixtures.ts", "src/cache.test.ts.snap",
    "src/cache.test.tsx.backup", "src/test_cache.py.backup", "test_cache.ts",
    "owner.test.ts/production.ts", "C:\\repo\\owner.test.ts\\production.ts",
    "test_cache.py/cache.py", "", "test_cache.py/",
  ]) {
    assert.equal(isDedicatedTestFile(path), false, path);
  }
});
