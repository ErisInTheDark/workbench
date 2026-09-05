/* No exports. Keywords: claims, project file links, cross-project roots, regression tests. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots.tsx";

test("file controls retain the owning project and workspace root instead of the current project", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchClaimHotspots, {
    global: true, projectNamesById: new Map(),
    projects: [
      { id: "workspace", kind: "workspace", roots: [{ id: "secondary", rootPath: "C:/second", relativePath: "", name: "secondary", isPrimary: false }] },
      { id: "ordinary", kind: "git", roots: [{ id: "main", rootPath: "C:/ordinary", relativePath: "", name: "main", isPrimary: true }] },
    ],
    stats: { claimHotspots: [
      { projectId: "workspace", rootId: "secondary", path: "src/view.ts", threadCount: 3 },
      { projectId: "ordinary", rootId: "main", path: "src/view.ts", threadCount: 2 },
    ] },
  }));
  assert.match(html, /data-project-file-project-id="workspace"[^>]*data-project-file-relative-path="secondary:src\/view.ts"/u);
  assert.match(html, /data-project-file-project-id="ordinary"[^>]*data-project-file-relative-path="src\/view.ts"/u);
});
