/* No production exports. Protect repo mount identity without changing ordinary file labels. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getProjectFilePathDisplay } from "./project-file-path";

test("repo mount labels identify their repository independently of the cache and commit", () => {
  for (const root of ["C:\\users\\test\\.cache\\repos\\mounts", "/data/.cache/repos/mounts"]) {
    for (const commit of ["a".repeat(40), "b".repeat(64)]) {
      const path = `${root}/github.com/openai/codex/${commit}/core/src/session/handlers.rs`;
      const display = getProjectFilePathDisplay(path, { lineNumber: 50, columnNumber: 3 });
      assert.equal(display.rootPrefix, "repo:codex:");
      assert.equal(display.label, "handlers.rs");
      assert.equal(display.fileName, "handlers.rs");
      assert.equal(display.locationSuffix, ":50:3");
      assert.equal(display.title, path.replaceAll("\\", "/"));
      assert.equal(getProjectFilePathDisplay(path, { label: "session handler" }).rootPrefix, display.rootPrefix);
    }
  }
});

test("repo names decode mount escapes and file labels retain within-repo disambiguation", () => {
  const mount = `/data/.cache/repos/mounts/host/team/~43ON/${"a".repeat(40)}`;
  const path = `${mount}/src/index.ts`;
  const display = getProjectFilePathDisplay(path, {
    disambiguationPaths: [path, `${mount}/test/index.ts`],
  });
  assert.equal(display.rootPrefix, "repo:CON:");
  assert.equal(display.label, "src/index.ts");
});

test("ordinary paths and incomplete mount lookalikes retain their display identity", () => {
  for (const path of [
    "/project/repos/mounts/host/team/repo/src/file.ts",
    "/data/.cache/repos/mounts/host/team/repo/not-a-commit/src/file.ts",
    "src/file.ts",
  ]) {
    assert.equal(getProjectFilePathDisplay(path).rootPrefix, "");
    assert.equal(getProjectFilePathDisplay(path).label, "file.ts");
  }
  assert.equal(getProjectFilePathDisplay("other:src/file.ts").rootPrefix, "other:");
});
