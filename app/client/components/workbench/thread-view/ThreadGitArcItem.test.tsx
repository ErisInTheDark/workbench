/*
 * Exports:
 * - No production exports; tests protect Git arc card defaults and collapsed result summaries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcCommandAction, GitArcCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import {
  createThreadGitArcCompareSummaryRows,
} from "./ThreadGitArcCollapsedSummary";
import type { ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcItem from "./ThreadGitArcItem";

function intent(action: GitArcCommandAction): GitArcCommandIntent {
  return {
    action,
    intentName: "disclosure defaults",
    paths: [],
    ref: null,
  };
}

function receipt(action: GitArcReceipt["action"], values: Partial<GitArcReceipt> = {}): GitArcReceipt {
  return {
    action,
    claimedPaths: [],
    intentName: "disclosure defaults",
    ref: "a".repeat(40),
    version: 1,
    ...values,
  };
}

function renderCard (
  action: GitArcCommandAction,
  result: GitArcReceipt | null = null,
  operationSummaryRows: readonly ThreadFileChangeListChange[] = [],
) {
  return renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: intent(action),
    durationMs: 12,
    operationSummaryRows,
    outcome: "completed",
    projectId: "project",
    receipt: result,
  }));
}

test("status and unknown Git arc cards start open while operation cards start closed", () => {
  for (const action of ["status", "unknown"] as const) {
    assert.match(renderCard(action), /<details[^>]*\bopen=/u, action);
  }
  for (const action of ["mv", "compare", "diff", "claims", "scope", "continue", "plan", "planStart", "release", "rescind", "restore", "start", "stash", "unstash"] as const) {
    assert.doesNotMatch(renderCard(action), /<details[^>]*\bopen=/u, action);
  }
});

test("conflicted unstash receipts open with editable paths and no Git continuation guidance", () => {
  const html = renderCard("unstash", receipt("unstash", {
    claimedPaths: ["src/conflict.ts"],
    conflictedPaths: ["src/conflict.ts"],
    fullScope: true,
  }));
  assert.match(html, /<details[^>]*\bopen=/u);
  assert.match(html, /Resolve conflict markers/u);
  assert.match(html, /src\/conflict\.ts/u);
  assert.match(html, /No Git continuation or abort command is required/u);
});

test("closed claim cards show representative icon rows and a remaining count", () => {
  const html = renderCard("plan", receipt("plan", {
    fullScope: true,
    plannedPaths: ["src/one.ts", "src/two.ts", "src/three.ts"],
  }));

  assert.match(html, /data-thread-git-arc-collapsed-summary="true"/u);
  assert.match(html, /src\/one\.ts/u);
  assert.match(html, /src\/two\.ts/u);
  assert.match(html, /and 1 more/u);
  assert.doesNotMatch(html, /src\/three\.ts/u);
  assert.match(html, /data-project-file-relative-path="src\/one\.ts"/u);
});

test("closed move cards show source and destination samples", () => {
  const html = renderCard("mv", receipt("mv", {
    mappings: [{ destination: "src/new.ts", source: "src/old.ts" }],
    mode: "applied",
  }));

  assert.match(html, /src\/old\.ts/u);
  assert.match(html, /src\/new\.ts/u);
  assert.match(html, /data-project-file-relative-path="src\/old\.ts"/u);
  assert.match(html, /data-project-file-relative-path="src\/new\.ts"/u);
});

test("closed compare cards show two file samples, totals, and a remaining count", () => {
  const rows = createThreadGitArcCompareSummaryRows([
    { additions: 3, deletions: 1, path: "src/one.ts", status: "M" },
    { additions: 2, deletions: 0, path: "src/two.ts", status: "A" },
    { additions: 0, deletions: 4, path: "src/three.ts", status: "D" },
  ]);
  const html = renderCard("compare", null, rows);

  assert.match(html, /src\/one\.ts/u);
  assert.match(html, /src\/two\.ts/u);
  assert.match(html, /and 1 more/u);
  assert.doesNotMatch(html, /src\/three\.ts/u);
  assert.match(html, /data-project-file-relative-path="src\/one\.ts"/u);
  assert.match(html, />\+3</u);
  assert.match(html, />-1</u);
});

test("artifact-only diff cards do not invent a collapsed preview", () => {
  const html = renderCard("diff");
  assert.doesNotMatch(html, /data-thread-git-arc-collapsed-summary/u);
  assert.doesNotMatch(html, /full diff available/iu);
});

test("nested claimed-file disclosure stays closed inside an open status card", () => {
  const html = renderCard("status", receipt("scope", {
    claimedPaths: ["src/claimed.ts"],
  }));

  assert.equal((html.match(/<details[^>]*\bopen=/gu) ?? []).length, 1);
  assert.match(html, /1 claimed file/u);
});
