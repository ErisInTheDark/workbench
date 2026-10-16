/*
 * Exports:
 * - No production exports; tests protect project-file conflict, mutation, forced creation, and containment behavior.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test } from "node:test";

import WorkbenchProjectFileController from "./WorkbenchProjectFileController.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

test("file writes preserve mtime conflicts and refresh snapshots only after mutation", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-project-file-");
  const root = temporary.path;
  const filePath = path.join(root, "note.md");
  await fs.writeFile(filePath, "before", "utf8");
  const project = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      resetToHead: false,
    });
    assert.equal("error" in conflict, true);
    assert.equal(await fs.readFile(filePath, "utf8"), "before");
    assert.equal(refreshes, 0);

    const saved = await controller.write({
      content: "after",
      expectedMtimeMs: mtimeMs,
      path: "note.md",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        resetToHead: false,
      }),
      /outside the project (?:root|workspace)/u,
    );

    const write = (relative: string, force: boolean) => controller.write({
      content: "<svg/>", expectedMtimeMs: 0, force, path: relative,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), resetToHead: false,
    });
    await assert.rejects(write("icon.svg", false), /ENOENT/u);
    assert.equal("changes" in await write("icon.svg", true), true);
    assert.equal(await fs.readFile(path.join(root, "icon.svg"), "utf8"), "<svg/>");
    await assert.rejects(write("image.png", true), /can be edited/u);
  } finally {
    await temporary.dispose();
  }
});
