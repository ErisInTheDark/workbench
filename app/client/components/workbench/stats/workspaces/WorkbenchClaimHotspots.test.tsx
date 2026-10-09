/* No exports. Tests protect project and root ownership of claim file links, and that only this machine's files link. */
import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import { renderWithStats } from "../stats-test-store";
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots.tsx";

test("file controls retain the owning project and workspace root instead of the current project", () => {
  const html = renderWithStats(createElement(WorkbenchClaimHotspots), {
    claims: { ...EMPTY_WORKBENCH_STATS_SECTIONS.claims, claimHotspots: [
      { daemonId: null, logicalProjectId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("workspace"), rootId: "secondary", path: "src/view.ts", threadCount: 3, threads: [] },
      { daemonId: null, logicalProjectId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("ordinary"), rootId: "main", path: "src/view.ts", threadCount: 2, threads: [] },
      // Another machine's file is shown but cannot open here.
      { daemonId: "elsewhere", logicalProjectId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("ordinary"), rootId: "main", path: "src/remote.ts", threadCount: 1, threads: [] },
    ] },
  }, {
    projects: [
      { id: fixtureIdentitySchemas.ProjectIdSchema.parse("workspace"), kind: "workspace", name: "workspace", roots: [{ id: "secondary", rootPath: "C:/second", relativePath: "", name: "secondary", isPrimary: false }] },
      { id: fixtureIdentitySchemas.ProjectIdSchema.parse("ordinary"), kind: "git", name: "ordinary", roots: [{ id: "main", rootPath: "C:/ordinary", relativePath: "", name: "main", isPrimary: true }] },
    ] as unknown as WorkbenchProjectOption[],
  });
  assert.match(html, /data-project-file-project-id="workspace"[^>]*data-project-file-relative-path="secondary:src\/view.ts"/u);
  assert.match(html, /data-project-file-project-id="ordinary"[^>]*data-project-file-relative-path="src\/view.ts"/u);
  assert.doesNotMatch(html, /data-project-file-project-id="ordinary"[^>]*data-project-file-relative-path="src\/remote.ts"/u);
  assert.match(html, /remote\.ts/u);
});
