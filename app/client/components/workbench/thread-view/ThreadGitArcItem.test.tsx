/*
 * Exports:
 * - No production exports; tests protect Git arc card defaults, collapsed result summaries and edit session output parsing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatGitArcEditText, parseGitArcEditText, type GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcEditStep } from "../../../workbench/thread/command-matchers/workbench-command-rendering";
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
  intentValues: Partial<GitArcCommandIntent> = {},
) {
  return renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { ...intent(action), ...intentValues },
    durationMs: 12,
    operationSummaryRows,
    outcome: "completed",
    projectId: "project",
    receipt: result,
  }));
}

test("subagent claim-transfer cards expose their transfer direction", () => {
  const release = renderCard("release", null, [], {
    paths: ["src/released.ts"],
    toSubagent: "mira",
  });
  const adopt = renderCard("adopt", null, [], {
    source: { name: "mira" },
  });

  assert.match(release, /aria-label="release claims to subagent"/u);
  assert.match(adopt, /aria-label="adopt claims from subagent"/u);
});

test("status and unknown Git arc cards start open while operation cards start closed", () => {
  for (const action of ["status", "unknown"] as const) {
    assert.match(renderCard(action), /<details[^>]*\bopen=/u, action);
  }
  for (const action of ["edit", "compare", "diff", "claims", "scope", "continue", "plan", "planStart", "release", "rescind", "restore", "start", "stash", "unstash"] as const) {
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

function editOutput(values: Partial<GitArcEditResult>) {
  return formatGitArcEditText({
    additionalClaims: [], additions: 3, blockedDirtyPaths: [], blockedPendingPaths: [], collisions: [], conflictedPaths: [],
    deletions: 1, diffs: [], fileCount: 2, files: [
      { additions: 1, binary: false, deletions: 1, ignored: false, lines: [1], movedFrom: "src/old.ts", path: "src/new.ts" },
      { additions: 2, binary: false, deletions: 0, ignored: false, lines: [4, 5], path: "src/app.ts" },
    ],
    ignoredFileCount: 0, page: 1, pageCount: 1, phase: "applied", releasedClaims: [], session: "abc12345", skippedFileCount: 0, warnings: [],
    ...values,
  });
}

function renderEditCard(step: GitArcEditStep, output: string) {
  return renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { ...intent("edit"), editStep: step },
    durationMs: 12,
    editResult: parseGitArcEditText(output),
    outcome: "completed",
    projectId: "project",
    receipt: null,
  }));
}

test("closed edit cards read the CLI output and show moved files at their destination with session totals", () => {
  const html = renderEditCard("apply", editOutput({}));

  assert.match(html, /Applied edit/u);
  assert.match(html, /edit session abc12345/u);
  assert.match(html, /data-project-file-relative-path="src\/new\.ts"/u);
  assert.match(html, /data-project-file-relative-path="src\/app\.ts"/u);
  assert.match(html, />\+3</u);
  assert.match(html, />-1</u);
});

test("reverted edit cards with conflicts open on the files to resolve", () => {
  const html = renderEditCard("revert", editOutput({ conflictedPaths: ["src/app.ts"], phase: "reverted" }));

  assert.match(html, /<details[^>]*\bopen=/u);
  assert.match(html, /Resolve conflict markers/u);
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

test("closed stack cards list every sealed commit as a commit row, never a truncated preview", () => {
  const stackedProposals = ["one", "two", "three"].map((name, index) => ({
    changes: [{ additions: index + 1, deletions: 0, kind: "update" as const, path: `src/${name}.ts` }],
    description: "",
    proposalId: `proposal-${name}`,
    title: `seal ${name}`,
  }));
  const html = renderCard("stack", receipt("stack", { layer: "layer", stackedProposals }));

  for (const name of ["one", "two", "three"]) assert.match(html, new RegExp(`seal ${name}`, "u"));
  assert.match(html, />\+3</u);
  assert.match(html, /aria-label="commit"/u);
  assert.doesNotMatch(html, /and \d+ more/u);
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
