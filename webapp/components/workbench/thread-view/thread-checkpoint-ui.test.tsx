/*
 * Exports:
 * - No production exports; Node tests protect checkpoint compare reuse, immediate proposal cards, summary actions, and clean diff rendering. Keywords: checkpoint, compare, proposal, card, file changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseUnifiedDiff } from "../../../lib/workbench/thread/thread-file-diff";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import { ThreadTurnDetails } from "./thread-view-items";

test("checkpoint compare uses established file-change rows without empty disclosures", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCompareItem, {
    changes: [
      { additions: 4, deletions: 2, path: "src/edited.ts", status: "U" },
      { additions: 3, deletions: 0, path: "src/created.ts", status: "A" },
      { additions: 0, deletions: 5, path: "src/deleted.ts", status: "D" },
    ],
    projectRootPath: "C:/workspace",
  }));

  assert.match(html, />Edited</u);
  assert.match(html, />Created</u);
  assert.match(html, />Deleted</u);
  assert.match(html, /src\/edited\.ts/u);
  assert.match(html, />\+4</u);
  assert.match(html, />-2</u);
  assert.doesNotMatch(html, /<button/u);
  assert.doesNotMatch(html, /No diff captured/u);
});

test("in-progress checkpoint commit commands render an immediate standalone card", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: null,
        command: "wb git arc propose --ref abc1234 -m \"Immediate proposal\" -- src/one.ts src/two.ts",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: null,
        exitCode: null,
        id: "proposal-command",
        processId: null,
        source: "agent",
        status: "inProgress",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "inProgress",
    },
  }));

  assert.match(html, /data-thread-checkpoint-card="true"/u);
  assert.match(html, /Immediate proposal/u);
  assert.match(html, /2 changed files/u);
  assert.doesNotMatch(html, /Loading commit proposal/u);
  assert.doesNotMatch(html, /Creating checkpoint commit proposal/u);
});

test("pending checkpoint proposal cards render command intent without a loading replacement", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/one.ts", "src/two.ts"],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: { status: "pending" },
    title: "Immediate proposal",
  }));

  assert.match(html, /Immediate proposal/u);
  assert.match(html, /2 changed files/u);
  assert.match(html, /data-placeholder="Optional description"/u);
  assert.match(html, /color-mix\(in_srgb,var\(--text\)_32%,transparent\)/u);
  assert.match(html, /<button[^>]*disabled=""/u);
  assert.match(html, />Commit<\/span>/u);
  assert.doesNotMatch(html, /Loading commit proposal/u);
});

test("pending arc-wide proposal cards show an honest summary before enrichment", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: [],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: { status: "pending" },
    title: "Immediate proposal",
  }));

  assert.match(html, /Immediate proposal/u);
  assert.match(html, /Arc changes/u);
  assert.match(html, /claimed changes will appear here/u);
  assert.doesNotMatch(html, /0 changed files|Loading commit proposal/u);
});

test("checkpoint commit progress uses the shared pill spinning border", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: true,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/one.ts"],
    sourceItemId: "proposal-command",
    state: { status: "pending" },
    title: "Immediate proposal",
  }));

  assert.match(html, />Committing\.\.\.</u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.equal(html.match(/data-workbench-spinning-border-trail="true"/gu)?.length, 2);
});

test("pending steers use the shared spinning border", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{
        clientId: "steer-one",
        content: [{ text: "Queued steer", text_elements: [], type: "text" }],
        id: "optimistic-user-message:steer:pending:one",
        type: "userMessage",
      }],
      itemsView: "full",
      startedAt: null,
      status: "inProgress",
    },
  }));

  assert.match(html, /data-thread-user-message-state="pending-steer"/u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.equal(html.match(/data-workbench-spinning-border-trail="true"/gu)?.length, 2);
  assert.doesNotMatch(html, /thread-pending-steer-message/u);
});

test("loaded checkpoint proposal cards keep actions in the summary and clean expanded diffs", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "Keep selected-path behavior explicit.",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/edited.ts", "src/created.ts"],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: {
      proposal: {
        baseCommit: "a".repeat(40),
        changes: [
          {
            additions: 2,
            deletions: 1,
            diff: "diff --git a/src/edited.ts b/src/edited.ts\n--- a/src/edited.ts\n+++ b/src/edited.ts\n@@ -1 +1,2 @@\n-old\n+new\n+newer\n",
            kind: { move_path: null, type: "update" },
            path: "src/edited.ts",
          },
          {
            additions: 1,
            deletions: 0,
            diff: "diff --git a/src/created.ts b/src/created.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/created.ts\n@@ -0,0 +1 @@\n+created\n",
            kind: { type: "add" },
            path: "src/created.ts",
          },
        ],
        committedSha: null,
        description: "Keep selected-path behavior explicit.",
        includeNewerAvailable: true,
        paths: ["src/edited.ts", "src/created.ts"],
        proposalId: "proposal-one",
        status: "proposed",
        title: "Polish checkpoints",
        unavailableReason: null,
      },
      status: "loaded",
    },
    title: "Polish checkpoints",
  }));

  const titleIndex = html.indexOf("Polish checkpoints");
  const descriptionIndex = html.indexOf("Keep selected-path behavior explicit.");
  const changesIndex = html.indexOf("data-thread-checkpoint-card-changes");
  const actionsIndex = html.indexOf("data-thread-checkpoint-card-actions");
  assert(titleIndex >= 0);
  assert(descriptionIndex > titleIndex);
  assert(changesIndex > descriptionIndex);
  assert(actionsIndex > changesIndex);
  assert.match(html, /2 changed files/u);
  assert.match(html, />\+3</u);
  assert.match(html, />-1</u);
  assert.match(html, /Include newer changes/u);
  assert.match(html, /type="checkbox"/u);
  assert.match(html, /class="peer sr-only"/u);
  assert.match(html, />Commit</u);
  assert(html.includes("focus:bg-transparent"));
  assert(html.includes("border-[color-mix(in_srgb,var(--text)_12%,transparent)]"));
});

test("preview diffs hide Git plumbing headers and fill disclosure width", () => {
  const html = renderToStaticMarkup(createElement(ThreadCodeDisplay, {
    diff: parseUnifiedDiff("diff --git a/src/edited.ts b/src/edited.ts\nindex 1111111..2222222 100644\n--- a/src/edited.ts\n+++ b/src/edited.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    preview: true,
    variant: "diff",
  }));

  assert(html.includes("-ml-6"));
  assert(html.includes("max-w-none"));
  assert.doesNotMatch(html, /diff --git/u);
  assert.doesNotMatch(html, /index 1111111\.\.2222222/u);
  assert.doesNotMatch(html, /--- a\/src/u);
  assert.doesNotMatch(html, /\+\+\+ b\/src/u);
});

test("Workbench checkboxes use the filled marker without an inner glyph", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchCheckbox, {
    checked: true,
    label: "Include newer changes",
    onChange: () => undefined,
  }));

  assert.match(html, /type="checkbox"/u);
  assert.match(html, /checked=""/u);
  assert.match(html, /bg-\[color-mix\(in_srgb,var\(--text\)_86%,var\(--bg\)_14%\)\]/u);
  assert.doesNotMatch(html, /<svg/u);
});
