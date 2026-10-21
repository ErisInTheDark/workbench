/*
 * No production exports. Regression wards protect which roots a thread's file links resolve against.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createProjectFileLinkRoots } from "./project-file-link-roots";

const root = (id: string, rootPath: string) => ({ id, rootPath });

test("a root path shared by the current workspace and another project resolves through the current workspace", () => {
  const roots = createProjectFileLinkRoots(
    [{ id: "other", kind: "workspace", name: "Other", roots: [root("app", "C:/Git/App")] }],
    "current",
    [root("app", "c:/git/app"), root("lib", "c:/git/lib")],
  );

  assert.deepEqual(roots.map(({ projectId, rootPath }) => ({ projectId, rootPath })), [
    { projectId: "current", rootPath: "c:/git/app" },
    { projectId: "current", rootPath: "c:/git/lib" },
  ]);
});

test("colliding root ids get case-insensitive numeric suffixes", () => {
  const roots = createProjectFileLinkRoots([
    { id: "a", kind: "git", name: "Web", roots: [root("r1", "c:/a")] },
    { id: "b", kind: "git", name: "web", roots: [root("r2", "c:/b")] },
    { id: "c", kind: "git", name: "WEB", roots: [root("r3", "c:/c")] },
  ], "current", []);

  assert.deepEqual(roots.map(({ id }) => id), ["Web", "web-2", "WEB-3"]);
});

test("a single-root current project contributes nothing; other projects still resolve", () => {
  const roots = createProjectFileLinkRoots(
    [
      { id: "current", kind: "git", name: "Current", roots: [root("main", "c:/current")] },
      { id: "other", kind: "git", name: "Other", roots: [root("main", "c:/other")] },
    ],
    "current",
    [root("main", "c:/current")],
  );

  assert.deepEqual(roots, [{ id: "Other", openPathMode: "root-relative", projectId: "other", rootPath: "c:/other" }]);
});
