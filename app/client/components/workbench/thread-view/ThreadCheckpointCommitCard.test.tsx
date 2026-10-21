/*
 * No production exports. Tests protect proposal loading, usable known content, action readiness, and the layout each known commit gets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import ThreadCheckpointCommitCard, { type ThreadCommitControls } from "./ThreadCheckpointCommitCard";
import WorkbenchClientProvider from "../WorkbenchClientProvider";

const controls = {
  commitMode: "commit",
  committing: false,
  freshCommitAvailable: false,
  includeNewer: false,
  onCommit: () => undefined,
  onCommitModeChange: () => undefined,
  onDescriptionChange: () => undefined,
  onIncludeNewerChange: () => undefined,
  onRetry: () => undefined,
  onTitleChange: () => undefined,
} satisfies ThreadCommitControls;

const pendingProps = {
  controls,
  sourceItemId: "proposal",
  state: { status: "pending" },
} satisfies ComponentProps<typeof ThreadCheckpointCommitCard>;

const proposed = {
  amendTargetMessage: null, amendTargetSha: null, baseCommit: "a".repeat(40), changes: [],
  committedSha: null, description: "proposal details", freshChanges: null, freshCommitMessage: null, includeNewerAvailable: false,
  mode: "commit", paths: [], proposalId: "proposal", status: "proposed",
  supersededByProposalId: null, supersededBySha: null, title: "loaded proposal", unavailableReason: null,
} satisfies GitCheckpointProposal;

test("unloaded proposal fields are busy rather than editable empty content", () => {
  const readonlyPreview = { density: "compact", expanded: true, sourceItemId: "proposal", state: { status: "pending" } } as const;
  for (const props of [pendingProps, readonlyPreview]) {
    const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, props));
    assert.match(html, /aria-busy="true"/u);
    assert.doesNotMatch(html, /contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);
  }
});

test("pending proposal enrichment preserves its known message", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps, message: { title: "keep this message", description: "already available" },
    paths: ["app/feature.ts"],
  }));
  assert.match(html, /keep this message/u);
  assert.match(html, /already available/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /<details/u);
});

test("cleared but hydrated proposal fields remain editable while enrichment is pending", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps,
    message: { availability: { title: true, description: true }, description: "", title: "" },
  }));
  assert.equal(html.match(/role="textbox"/gu)?.length, 2);
  assert.match(html, /contenteditable="plaintext-only"/iu);
  assert.match(html, /aria-busy="true"/u);
});

test("static previews do not claim to be loading and failures expose recovery instead of busy content", () => {
  const idle = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    density: "compact", message: { description: "", title: "available preview" }, sourceItemId: "proposal", state: { status: "idle" },
  }));
  assert.match(idle, /available preview/u);
  assert.doesNotMatch(idle, /aria-busy="true"|contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);

  const failed = renderToStaticMarkup(createElement(WorkbenchClientProvider, {
    client: { controls: null, mounted: null },
    children: createElement(ThreadCheckpointCommitCard, {
      ...pendingProps, state: { status: "error", error: "proposal read failed", retryable: true },
    }),
  }));
  assert.match(failed, /data-thread-checkpoint-card-error="true"/u);
  assert.match(failed, /<button/u);
  assert.doesNotMatch(failed, /aria-busy="true"|data-thread-checkpoint-commit-action/u);
});

test("bounded summaries display their exact changed-file count", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    expanded: true,
    sourceItemId: "proposal",
    state: {
      status: "summary",
      summary: { changeCount: 1_300, description: "", title: "capture fixtures", totals: null },
    },
  }));

  assert.match(html, />1300\b/u);
});

test("loaded proposed cards restore editing and commit actions only with controls", () => {
  const interactive = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps, state: { status: "loaded", proposal: proposed },
  }));
  assert.doesNotMatch(interactive, /aria-busy="true"/u);
  assert.match(interactive, /loaded proposal/u);
  assert.match(interactive, /proposal details/u);
  assert.match(interactive, /contenteditable="plaintext-only"/iu);
  assert.match(interactive, /data-thread-checkpoint-commit-action="true"/u);

  const readonly = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    sourceItemId: "proposal", state: { status: "loaded", proposal: proposed },
  }));
  assert.match(readonly, /loaded proposal/u);
  assert.doesNotMatch(readonly, /contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);
});

test("a collapsible proposal shows its title, totals and actions once whether open or closed", () => {
  const proposal = {
    ...proposed,
    changes: [{ additions: 4, deletions: 2, diff: "", kind: { move_path: null, type: "update" }, path: "src/one.ts" }],
  } satisfies GitCheckpointProposal;
  const render = (open: boolean) => renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps,
    disclosure: { closedAction: createElement("button", { "data-closed-action": "true" }), onOpenChange: () => undefined, open },
    state: { status: "loaded", proposal },
  }));
  const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

  const closed = render(false);
  assert.equal(count(closed, /loaded proposal/gu), 1);
  assert.equal(count(closed, />\+4</gu), 1);
  assert.match(closed, /aria-expanded="false"/u);
  assert.match(closed, /data-closed-action="true"/u);
  assert.doesNotMatch(closed, /proposal details|data-thread-checkpoint-commit-action/u);

  const open = render(true);
  assert.equal(count(open, /loaded proposal/gu), 1);
  assert.equal(count(open, />\+4</gu), 1);
  assert.equal(count(open, /data-thread-checkpoint-commit-action="true"/gu), 1);
  assert.match(open, /aria-expanded="true"/u);
  assert.match(open, /proposal details/u);
  assert.doesNotMatch(open, /data-closed-action/u);
});

test("readonly commits are a closed disclosure when they have a body and a static row otherwise", () => {
  const withBody = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    sourceItemId: "commit",
    state: {
      status: "summary",
      summary: {
        changes: [{ additions: 2, deletions: 1, kind: "update", path: "app/a.ts" }], committedSha: "c".repeat(40), description: "the body", title: "titled commit",
        totals: { files: 1, premise: { additions: 2, deletions: 1 }, tests: { additions: 0, deletions: 0 } },
      },
    },
  }));
  assert.match(withBody, /aria-expanded="false"/u);
  assert.match(withBody, /titled commit/u);
  assert.match(withBody, /cccccccc/u);
  assert.doesNotMatch(withBody, /the body|app\/a\.ts/u);

  const titleOnly = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    sourceItemId: "commit",
    state: { status: "summary", summary: { committedSha: "d".repeat(40), description: "", title: "bare commit", totals: null } },
  }));
  assert.match(titleOnly, /bare commit/u);
  assert.doesNotMatch(titleOnly, /aria-expanded/u);
});

test("accepted proposal amendments keep their pending action visible until completion", () => {
  const proposal = {
    ...proposed, amendability: { status: "available" }, committedSha: "b".repeat(40),
    description: "accepted description", proposalId: "accepted-proposal", status: "committed", title: "accepted proposal",
  } satisfies GitCheckpointProposal;
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps,
    controls: { ...controls, committing: true },
    message: { description: proposal.description, title: "amended proposal" },
    state: { status: "loaded", proposal },
  }));

  assert.match(html, /aria-expanded="true"/u);
  assert.match(html, /<button(?=[^>]*data-thread-checkpoint-commit-action="true")(?=[^>]*disabled="")[^>]*>/u);
  assert.match(html, /Amending\.\.\./u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.doesNotMatch(html, />Committed</u);
});
