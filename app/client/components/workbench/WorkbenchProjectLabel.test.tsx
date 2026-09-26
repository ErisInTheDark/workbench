/*
 * No production exports. Rendered regression checks protect logical-project label usefulness.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";

const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");

function project(name: string, displayPath: string, matchKey: string): WorkbenchLogicalProject {
  return {
    id: LogicalProjectIdSchema.parse("b12f7e1e-81b6-4c30-bdc0-f83475981003"),
    matchKey, label: name, displayName: name, displayPath,
    locations: [{
      target: { daemonId, projectId }, daemonId, hostname: "tower-of-floof",
      name, rootPath: `C:/git/${name}`, displayPath, project: null,
    }],
  };
}

test("project rows omit a folder address that repeats the visible project name", () => {
  for (const matchKey of ["local://C:/git/bak", "remote://example.test/workbench"]) {
    const name = matchKey.startsWith("local://") ? "bak" : "workbench";
    const html = renderToStaticMarkup(createElement(WorkbenchProjectLabel, {
      project: project(name, name, matchKey),
    }));
    assert.equal((html.match(new RegExp(`>${name}<`, "gu")) ?? []).length, 1);
  }

  const distinct = renderToStaticMarkup(createElement(WorkbenchProjectLabel, {
    project: project("workbench", "+convex-lab", "remote://example.test/workbench"),
  }));
  assert.match(distinct, />\+convex-lab</u);
});
