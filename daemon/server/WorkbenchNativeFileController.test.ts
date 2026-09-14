/*
 * Exports:
 * - No production exports; tests protect native file launch path validation. Keywords: native, file, path, safety, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchNativeFileController from "./WorkbenchNativeFileController.ts";

test("native open rejects non-local absolute paths before filesystem or process access", async () => {
  let projectReads = 0;
  const controller = new WorkbenchNativeFileController({
    resolveProjectById: async () => {
      projectReads += 1;
      throw new Error("project lookup should not run");
    },
  });
  await assert.rejects(
    controller.open({ absolutePath: "relative/file.md", path: "" }),
    /local absolute file path/u,
  );
  await assert.rejects(
    controller.open({ absolutePath: "//server/share/file.md", path: "" }),
    /local absolute file path/u,
  );
  assert.equal(projectReads, 0);
});

test("link roots preserve Windows deduplication and distinct Linux root spelling", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const controller = new WorkbenchNativeFileController({
      resolveProjectById: async () => { throw new Error("unexpected project lookup"); },
    }, {
      platform,
      resolveLinkRoot: async (filePath) => ({
        id: filePath.split("/").at(-2)!,
        rootPath: filePath.slice(0, filePath.lastIndexOf("/")),
      }),
    });
    const { roots } = await controller.linkRoots({ paths: ["/work/Repo/a.md", "/work/repo/b.md", "/work/repo/c.md"] });
    assert.deepEqual(roots.map((root) => root.rootPath), platform === "linux"
      ? ["/work/Repo", "/work/repo"]
      : ["/work/repo"]);
  }
});
