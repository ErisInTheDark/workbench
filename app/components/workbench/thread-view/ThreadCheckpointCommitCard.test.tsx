/*
 * No production exports. Tests protect proposal loading, usable known content, and action readiness.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
import WorkbenchClientProvider from "../WorkbenchClientProvider";
import type { WorkbenchClientController } from "../workbench-client-context";

const pendingProps = {
  commitMode: "commit",
  committing: false,
  description: "",
  freshCommitAvailable: false,
  includeNewer: false,
  onCommit: () => undefined,
  onCommitModeChange: () => undefined,
  onDescriptionChange: () => undefined,
  onIncludeNewerChange: () => undefined,
  onRetry: () => undefined,
  onTitleChange: () => undefined,
  paths: [],
  sourceItemId: "proposal",
  state: { status: "pending" },
  title: "",
} satisfies ComponentProps<typeof ThreadCheckpointCommitCard>;

test("unloaded proposal fields are busy rather than editable empty content", () => {
  for (const presentation of ["full", "compact-preview", "compact-commit"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, { ...pendingProps, presentation }));
    assert.match(html, /aria-busy="true"/u);
    assert.doesNotMatch(html, /contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);
  }
});

test("pending proposal enrichment preserves its known message", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps, title: "keep this message", description: "already available",
    paths: ["app/feature.ts"],
  }));
  assert.match(html, /keep this message/u);
  assert.match(html, /already available/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /<details/u);
});

test("cleared but hydrated proposal fields remain editable while enrichment is pending", () => {
  for (const presentation of ["full", "compact-commit"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
      ...pendingProps,
      presentation,
      messageAvailability: { title: true, description: true },
    }));
    assert.equal(html.match(/role="textbox"/gu)?.length, 2);
    assert.match(html, /contenteditable="plaintext-only"/iu);
    assert.match(html, /aria-busy="true"/u);
  }
});

test("static previews do not claim to be loading and failures expose recovery instead of busy content", () => {
  const idle = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps, presentation: "compact-preview", state: { status: "idle" }, title: "available preview",
  }));
  assert.match(idle, /available preview/u);
  assert.doesNotMatch(idle, /aria-busy="true"|contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);

  const failed = renderToStaticMarkup(createElement(WorkbenchClientProvider, {
    client: { controls: null, explorer: {} as WorkbenchClientController["explorer"], mounted: null },
    children: createElement(ThreadCheckpointCommitCard, {
      ...pendingProps, state: { status: "error", error: "proposal read failed", retryable: true },
    }),
  }));
  assert.match(failed, /data-thread-checkpoint-card-error="true"/u);
  assert.match(failed, /<button/u);
  assert.doesNotMatch(failed, /aria-busy="true"|data-thread-checkpoint-commit-action/u);
});

test("loaded proposed cards restore editing and commit actions only in interactive presentations", () => {
  const proposal = {
    amendTargetMessage: null, amendTargetSha: null, baseCommit: "a".repeat(40), changes: [],
    committedSha: null, description: "proposal details", freshChanges: null, includeNewerAvailable: false,
    mode: "commit", paths: [], proposalId: "proposal", status: "proposed",
    supersededByProposalId: null, supersededBySha: null, title: "loaded proposal", unavailableReason: null,
  } satisfies GitCheckpointProposal;
  for (const presentation of ["full", "compact-commit", "compact-preview"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
      ...pendingProps, presentation, state: { status: "loaded", proposal },
      title: proposal.title, description: proposal.description,
    }));
    assert.doesNotMatch(html, /aria-busy="true"/u);
    assert.match(html, /loaded proposal/u);
    if (presentation === "compact-preview") {
      assert.doesNotMatch(html, /contenteditable="(?:true|plaintext-only)"|data-thread-checkpoint-commit-action/iu);
    } else {
      assert.match(html, /contenteditable="plaintext-only"/iu);
      assert.match(html, /data-thread-checkpoint-commit-action="true"/u);
    }
  }
});

test("accepted proposal amendments keep their pending action visible until completion", () => {
  const proposal = {
    amendTargetMessage: null, amendTargetSha: null, amendability: { status: "available" },
    baseCommit: "a".repeat(40), changes: [], committedSha: "b".repeat(40),
    description: "accepted description", freshChanges: null, includeNewerAvailable: false,
    mode: "commit", paths: [], proposalId: "accepted-proposal", status: "committed",
    supersededByProposalId: null, supersededBySha: null, title: "accepted proposal", unavailableReason: null,
  } satisfies GitCheckpointProposal;
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    ...pendingProps,
    committing: true,
    description: proposal.description,
    state: { status: "loaded", proposal },
    title: "amended proposal",
  }));

  assert.match(html, /<button(?=[^>]*data-thread-checkpoint-commit-action="true")(?=[^>]*disabled="")[^>]*>/u);
  assert.match(html, /Amending\.\.\./u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.doesNotMatch(html, />Committed</u);
});
