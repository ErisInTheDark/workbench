/*
 * No production exports. Mounted tests protect proposal commit choices the controller derives from loaded proposal state.
 */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { WorkbenchGitArcProposalState } from "workbench-shared/workbench/thread/thread-state";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";
import { ThreadGitArcObservationProvider } from "./ThreadGitArcObservationContext";
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

const change = { additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b\n", kind: { type: "update", move_path: null }, path: "src/one.ts" } as const;
const amendment = {
  amendTargetMessage: { description: "", title: "Current title" }, amendTargetSha: "a".repeat(40), baseCommit: "b".repeat(40),
  changes: [change], committedSha: null, description: "Amended description", freshChanges: [change],
  freshCommitMessage: { description: "Fresh description", title: "Fresh title" }, includeNewerAvailable: false,
  mode: "amend", paths: ["src/one.ts"], proposalId: "amendment", status: "proposed",
  supersededByProposalId: null, supersededBySha: null, title: "Amended title", unavailableReason: null,
} satisfies GitCheckpointProposal;

/** Mounts one observed, loaded proposal card and runs checks against its container. */
async function mountCard(proposal: GitCheckpointProposal, lifecycleProposals: WorkbenchGitArcProposalState[] | null, run: (container: HTMLElement) => Promise<void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WorkbenchClientProvider, {
        client: { controls: null, mounted: null },
        children: createElement(ThreadGitArcObservationProvider, {
          lifecycleProposals,
          observeProposal: () => () => {},
          proposals: { [proposal.proposalId]: { proposal, status: "loaded" } },
          children: createElement(ThreadCheckpointCommitController, {
            cwd: "C:/workspace", harness: "codex", intent: null, proposalId: proposal.proposalId,
            sourceItemId: "proposal-item", threadId: "thread-one",
          }),
        }),
      }));
    });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
}

test("amend proposals offer their stored fresh commit without the proposing tool call", async () => {
  await mountCard(amendment, null, async (container) => {
    const fresh = container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Commit fresh"]');
    assert.ok(fresh, "the fresh commit choice is offered");
    await act(async () => { fresh.click(); });
    assert.equal(container.querySelector('[aria-label="Commit title"]')?.textContent, "Fresh title");
    assert.equal(container.querySelector('[aria-label="Commit description"]')?.textContent, "Fresh description");
  });
});

test("a loaded proposal without a fresh choice commits in its own mode even when its summary said amend", async () => {
  const sealed = {
    ...amendment, amendTargetMessage: null, amendTargetSha: null, description: "Fresh description",
    freshChanges: null, freshCommitMessage: null, mode: "commit", title: "Fresh title",
  } satisfies GitCheckpointProposal;
  const summary: WorkbenchGitArcProposalState = {
    proposalId: sealed.proposalId,
    status: "proposed",
    summary: { changes: null, committedSha: null, description: "Amended description", mode: "amend", title: "Amended title" },
  };
  await mountCard(sealed, [summary], async (container) => {
    assert.equal(container.querySelector('[role="radio"][aria-label="Commit fresh"]'), null);
    assert.equal(container.querySelector('[data-thread-checkpoint-commit-action="true"]')?.textContent, "Commit");
    assert.equal(container.querySelector('[aria-label="Commit title"]')?.textContent, "Fresh title");
    assert.equal(container.querySelector('[aria-label="Commit description"]')?.textContent, "Fresh description");
  });
});
