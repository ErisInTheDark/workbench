/*
 * Exports:
 * - No production exports. Tests protect discovered project assets, stable initial fallbacks, and icon presence in every canonical label variant.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon.tsx";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel.tsx";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function project(overrides: Partial<WorkbenchProjectOption> = {}): WorkbenchProjectOption {
  return {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("team/alpha"),
    kind: "git",
    lastCommitTimeMs: null,
    name: "alpha",
    relativePath: "team/alpha",
    rootPath: "C:/projects/team/alpha",
    roots: [{
      id: "alpha",
      isPrimary: true,
      name: "alpha",
      relativePath: "team/alpha",
      rootPath: "C:/projects/team/alpha",
    }],
    ...overrides,
  };
}

test("renders a stable uppercase initial when no project asset exists", () => {
  const first = renderToStaticMarkup(createElement(WorkbenchProjectIcon, { project: project() }));
  const second = renderToStaticMarkup(createElement(WorkbenchProjectIcon, { project: project() }));
  assert.equal(first, second);
  assert.match(first, />A<\/span>$/u);
});

test("renders the selected project asset through the encoded daemon route", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchProjectIcon, {
    project: project({ icon: { path: "public/favicon.png", rootId: "alpha" } }),
  }));
  assert.match(html, /<img[^>]+src="[^"]*\/daemon\/project-icons\/team%2Falpha\?asset=team%2Falpha%3Aalpha%3Apublic%2Ffavicon\.png"/u);
});

test("includes one project icon in every canonical label variant", () => {
  const selected = project({ icon: { path: "public/favicon.png", rootId: "alpha" } });
  for (const variant of ["card", "thread", "heading"] as const) {
    const html = renderToStaticMarkup(createElement(WorkbenchProjectLabel, { project: selected, variant }));
    assert.match(html, /<img/u);
    assert.match(html, />alpha</u);
    assert.match(html, />team\/alpha</u);
  }
});
