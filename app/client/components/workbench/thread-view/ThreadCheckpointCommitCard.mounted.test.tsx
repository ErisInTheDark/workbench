/*
 * No production exports. Mounted tests protect commit card disclosure state across live state transitions.
 */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import ThreadCheckpointCommitCard, { type ThreadCommitControls } from "./ThreadCheckpointCommitCard";
import WorkbenchClientProvider from "../WorkbenchClientProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so it never implements `innerText`; editable fields read it on every commit.
if (!("innerText" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ""; },
    set(this: HTMLElement, value: string) { this.textContent = value; },
  });
}

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

const proposed = {
  amendTargetMessage: null, amendTargetSha: null, baseCommit: "a".repeat(40),
  changes: [{ additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b\n", kind: { type: "update", move_path: null }, path: "src/one.ts" }],
  committedSha: null, description: "proposal details", freshChanges: null, freshCommitMessage: null, includeNewerAvailable: false,
  mode: "commit", paths: ["src/one.ts"], proposalId: "proposal", status: "proposed",
  supersededByProposalId: null, supersededBySha: null, title: "loaded proposal", unavailableReason: null,
} satisfies GitCheckpointProposal;

test("accepting a visible proposal in place leaves its file list as the user left it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (props: Partial<ComponentProps<typeof ThreadCheckpointCommitCard>>) => createElement(WorkbenchClientProvider, {
    client: { controls: null, mounted: null },
    children: createElement(ThreadCheckpointCommitCard, {
      controls, sourceItemId: "proposal", state: { proposal: proposed, status: "loaded" }, ...props,
    }),
  });
  const changesOpen = () => container.querySelector<HTMLDetailsElement>("[data-thread-checkpoint-card-changes] > details")?.open;
  try {
    await act(async () => { root.render(render({})); });
    assert.equal(changesOpen(), false);

    // The observed commit lands while the card still reports its commit in flight.
    await act(async () => {
      root.render(render({
        controls: { ...controls, committing: true },
        state: { proposal: { ...proposed, committedSha: "b".repeat(40), status: "committed" }, status: "loaded" },
      }));
    });
    assert.equal(changesOpen(), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
