/*
 * Exports:
 * - No production exports; tests protect project-file conflict, mutation, and containment behavior. Keywords: project, file, mtime, containment, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import WorkbenchProjectFileController from "./WorkbenchProjectFileController.ts";

test("file writes preserve mtime conflicts and refresh snapshots only after mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-file-"));
  const filePath = path.join(root, "note.md");
  await fs.writeFile(filePath, "before", "utf8");
  const project = {
    id: "project",
    kind: "git" as const,
    root,
    rootPath: root,
    roots: [{ id: "project", name: "project", root, rootPath: root }],
  };
  let refreshes = 0;
  const controller = new WorkbenchProjectFileController(
    { resolveProjectById: async () => project },
    {
      refreshAfterFileMutation: async () => {
        refreshes += 1;
        return { changes: {} };
      },
    },
  );
  try {
    const mtimeMs = Math.trunc((await fs.stat(filePath)).mtimeMs);
    const conflict = await controller.write({
      content: "blocked",
      expectedMtimeMs: mtimeMs - 1,
      path: "note.md",
      projectId: "project",
      resetToHead: false,
    });
    assert.equal("error" in conflict, true);
    assert.equal(await fs.readFile(filePath, "utf8"), "before");
    assert.equal(refreshes, 0);

    const saved = await controller.write({
      content: "after",
      expectedMtimeMs: mtimeMs,
      path: "note.md",
      projectId: "project",
      resetToHead: false,
    });
    assert.equal("changes" in saved, true);
    assert.equal(await fs.readFile(filePath, "utf8"), "after");
    assert.equal(refreshes, 1);

    await assert.rejects(
      controller.write({
        content: "escape",
        expectedMtimeMs: 0,
        force: true,
        path: "../outside.md",
        projectId: "project",
        resetToHead: false,
      }),
      /outside the project (?:root|workspace)/u,
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
