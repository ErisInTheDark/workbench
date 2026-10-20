/*
 * Exports:
 * - No production exports; tests protect what Git arc cards keep in view while closed, which open by themselves, how arc
 *   reads become steps inside a run, and edit session output parsing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatGitArcEditText, parseGitArcEditText, type GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcEditStep } from "../../../workbench/thread/command-matchers/workbench-command-rendering";
import type { GitArcCommandAction, GitArcCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import ContextualProjectProvider from "../ContextualProjectProvider";
import { createThreadGitArcCompareSummaryRows } from "./ThreadGitArcCollapsedSummary";
import ThreadGitArcCardBody from "./ThreadGitArcCardBody";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { buildGitArcCard } from "./thread-git-arc-card";
import { ThreadRowChromeContext } from "./thread-row-chrome";

type ItemProps = ComponentProps<typeof ThreadGitArcItem>;

function intent(action: GitArcCommandAction, values: Partial<GitArcCommandIntent> = {}): GitArcCommandIntent {
  return { action, intentName: "disclosure defaults", paths: [], ref: null, ...values };
}

function receipt(action: GitArcReceipt["action"], values: Partial<GitArcReceipt> = {}): GitArcReceipt {
  return { action, claimedPaths: [], intentName: "disclosure defaults", ref: "a".repeat(40), version: 1, ...values };
}

function props(action: GitArcCommandAction, values: Partial<ItemProps> = {}): ItemProps {
  return { commandIntent: intent(action), durationMs: 12, outcome: "completed", receipt: null, ...values };
}

function render(itemProps: ItemProps, chrome: "row" | "step" = "row") {
  return renderToStaticMarkup(createElement(ContextualProjectProvider, {
    children: createElement(ThreadRowChromeContext.Provider, { value: chrome }, createElement(ThreadGitArcItem, itemProps)),
    id: "project",
  }));
}

/** What the card opens into, built from the same props. */
function renderBody(itemProps: ItemProps) {
  const card = buildGitArcCard({
    asRunStep: false, currentPlan: null, editResult: itemProps.editResult ?? null, failureReason: itemProps.failureReason ?? null,
    intent: itemProps.commandIntent, interruptedBySteer: false, name: null, outcome: itemProps.outcome, receipt: itemProps.receipt,
    statusFacts: itemProps.statusFacts, statusOutput: itemProps.statusOutput, typedFailure: null,
  });
  return renderToStaticMarkup(createElement(ContextualProjectProvider, {
    children: createElement(ThreadGitArcCardBody, { card, editResult: itemProps.editResult ?? null, statusIncomplete: false, statusOutput: itemProps.statusOutput }),
    id: "project",
  }));
}

const isOpen = (html: string) => /<details[^>]*\bopen=/u.test(html);

test("subagent claim-transfer cards expose their transfer direction", () => {
  const release = render(props("release", { commandIntent: intent("release", { paths: ["src/released.ts"], toSubagent: "mira" }) }));
  const adopt = render(props("adopt", { commandIntent: intent("adopt", { source: { name: "mira" } }) }));
  assert.match(release, /aria-label="release claims to subagent"/u);
  assert.match(adopt, /aria-label="adopt claims from subagent"/u);
});

test("only unknown actions and conflicts open by themselves", () => {
  assert.ok(isOpen(render(props("unknown"))));
  for (const action of ["edit", "compare", "diff", "claims", "scope", "continue", "plan", "planStart", "release", "rescind", "restore", "start", "stash", "status", "unstash"] as const) {
    assert.ok(!isOpen(render(props(action))), action);
  }
  const conflicted = props("unstash", { receipt: receipt("unstash", { claimedPaths: ["src/conflict.ts"], conflictedPaths: ["src/conflict.ts"], fullScope: true }) });
  assert.ok(isOpen(render(conflicted)));
  const body = renderBody(conflicted);
  assert.match(body, /Resolve conflict markers/u);
  assert.match(body, /src\/conflict\.ts/u);
});

const summaryText = (html: string) => (/<summary[^>]*>([\s\S]*?)<\/summary>/u.exec(html)?.[1] ?? "")
  .replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");

test("status cards keep every relevant count on their one line, whatever the agent asked to expand", () => {
  const html = render(props("status", {
    statusFacts: { cleanClaims: 8, dirtyClaims: ["src/dirty.ts"], unclaimedDirt: ["src/stray.ts", "src/other.ts"] },
  }));
  const line = summaryText(html);
  assert.ok(!isOpen(html));
  assert.match(line, /1 dirty/u);
  assert.match(line, /8 clean/u);
  assert.match(line, /2 unclaimed dirt/u);
  assert.doesNotMatch(html, /src\/dirty\.ts|data-thread-git-arc-collapsed-summary/u);
});

test("released cards count the claims they released on the line and open onto exactly those paths", () => {
  const released = props("release", { receipt: receipt("release", { removedClaims: ["src/one.ts", "src/two.ts", "src/three.ts"] }) });
  assert.match(summaryText(render(released)), /Released 3 claims/u);
  const body = renderBody(released);
  for (const name of ["one", "two", "three"]) assert.match(body, new RegExp(`src/${name}\\.ts`, "u"));
});

test("plain cards are one line while closed; preview cards keep their result in view", () => {
  const plan = props("plan", { receipt: receipt("plan", { fullScope: true, plannedPaths: ["src/one.ts", "src/two.ts", "src/three.ts"] }) });
  assert.doesNotMatch(render(plan), /data-thread-git-arc-collapsed-summary/u);
  assert.match(renderBody(plan), /src\/three\.ts/u);

  const restored = render(props("restore", { commandIntent: intent("restore", { paths: ["src/one.ts", "src/two.ts", "src/three.ts"] }) }));
  assert.match(restored, /data-project-file-relative-path="src\/one\.ts"/u);
  assert.match(restored, /data-project-file-relative-path="src\/two\.ts"/u);
  assert.match(restored, /and 1 more/u);
  assert.doesNotMatch(restored, /src\/three\.ts/u);
});

test("compare cards carry their totals on the line, and inside a run arc reads are steps while lifecycle stays a card", () => {
  const operationSummaryRows = createThreadGitArcCompareSummaryRows([
    { additions: 3, deletions: 1, path: "src/one.ts", status: "M" },
    { additions: 2, deletions: 0, path: "src/two.ts", status: "A" },
  ]);
  const card = render(props("compare", { operationSummaryRows }));
  assert.match(card, /data-thread-card="true"/u);
  assert.match(card, />\+5</u);
  assert.match(card, />-1</u);
  assert.doesNotMatch(card, /src\/one\.ts/u);

  assert.doesNotMatch(render(props("compare", { operationSummaryRows }), "step"), /data-thread-card=/u);
  assert.match(render(props("stack", { receipt: receipt("stack", { layer: "layer" }) }), "step"), /data-thread-card="true"/u);
});

test("stack cards count their commits on the line and open into every sealed commit", () => {
  const stackedProposals = ["one", "two", "three"].map((name, index) => ({
    changes: [{ additions: index + 1, deletions: 0, kind: "update" as const, path: `src/${name}.ts` }],
    description: "",
    proposalId: `proposal-${name}`,
    title: `seal ${name}`,
  }));
  const stack = props("stack", { receipt: receipt("stack", { layer: "layer", stackedProposals }) });
  assert.match(render(stack), /3 proposals/u);
  const body = renderBody(stack);
  for (const name of ["one", "two", "three"]) assert.match(body, new RegExp(`seal ${name}`, "u"));
  assert.doesNotMatch(body, /and \d+ more/u);
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

function editProps(step: GitArcEditStep, output: string) {
  return props("edit", { commandIntent: intent("edit", { editStep: step }), editResult: parseGitArcEditText(output) });
}

test("closed edit cards read the CLI output and show moved files at their destination with session totals", () => {
  const html = render(editProps("apply", editOutput({})));
  assert.match(html, /Applied edit/u);
  assert.match(html, /edit session abc12345/u);
  assert.match(html, /data-project-file-relative-path="src\/new\.ts"/u);
  assert.match(html, /data-project-file-relative-path="src\/app\.ts"/u);
  assert.match(html, />\+3</u);
  assert.match(html, />-1</u);
});

test("reverted edit cards with conflicts open on the files to resolve", () => {
  const html = render(editProps("revert", editOutput({ conflictedPaths: ["src/app.ts"], phase: "reverted" })));
  assert.ok(isOpen(html));
  assert.match(html, /Resolve conflict markers/u);
});
