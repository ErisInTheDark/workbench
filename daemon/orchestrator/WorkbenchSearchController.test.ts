/*
 * No production exports. Tests protect search projection ownership, signatures, ordering, and disposal. Keywords: search, projection, sqlite, lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchSearchController from "./WorkbenchSearchController";

test("search refreshes projects and changed current-project files before querying", async () => {
  const calls: string[] = [];
  const database = {
    replaceSearchProjectFiles: async (projectId: string, paths: readonly string[]) => { calls.push(`files:${projectId}:${paths.join(",")}`); },
    replaceSearchProjects: async (projects: readonly object[]) => { calls.push(`projects:${projects.length}`); },
    search: async () => { calls.push("search"); return { results: [] }; },
  };
  const controller = new WorkbenchSearchController({
    database,
    readCatalog: async () => ({
      data: [{ id: "project", name: "Project", rootPath: "C:/project", roots: [] }],
      rootPath: "C:/",
    }),
    readProjectSnapshot: async () => ({
      changes: {}, projectId: "project", root: "Project", rootPath: "C:/project", roots: [],
      tree: [{ isIgnored: false, name: "one.ts", path: "one.ts", type: "file" as const }],
      workbenchStorageRootPath: "C:/project/.workbench",
    }),
  });
  await controller.search({ projectId: "project", query: "one" });
  await controller.search({ projectId: "project", query: "two" });
  assert.deepEqual(calls, [
    "projects:1", "files:project:one.ts", "search",
    "projects:1", "search",
  ]);
  await controller.dispose();
  await assert.rejects(controller.search({ projectId: "project", query: "after" }), /disposed/u);
});
