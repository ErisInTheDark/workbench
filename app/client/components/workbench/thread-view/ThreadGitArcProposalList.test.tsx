/*
 * Exports:
 * - No production exports; tests protect commit-all availability in a collapsed proposals header.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import WorkbenchClientStateController, { type WorkbenchClientStateSnapshot } from "../../../workbench/state/WorkbenchClientStateController";
import { WorkbenchClientStateContext } from "../workbench-client-state-context";
import ThreadCheckpointCommitActions, { type ThreadCheckpointStoredProposal } from "./ThreadCheckpointCommitActions";
import ThreadGitArcProposalList from "./ThreadGitArcProposalList";

const stored = (proposalId: string): ThreadCheckpointStoredProposal => ({
  description: "",
  hasChanges: true,
  mode: "commit",
  proposalId,
  status: "proposed",
  title: proposalId,
});

/** A memory-mode stand-in whose snapshot can carry the saved disclosure preference the real controller exposes. */
function clientState(open: boolean) {
  const records: WorkbenchClientStateRecord[] = open ? [] : [
    { kind: "globalPreference", preference: { key: "threadGitArcProposalsOpen", value: false } },
  ];
  const snapshot: WorkbenchClientStateSnapshot = {
    attachmentsAsUrls: false,
    daemonRegistrationId: "memory",
    error: "",
    records,
    registrations: [],
    revision: 1,
    schemaVersion: appStateReleases.threadGitArcProposalsOpen.version,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as WorkbenchClientStateController;
}

/** Bulk summaries stand in for cards that a collapsed header never lets load, so readiness is real. */
function renderList(open: boolean, proposalIds: readonly string[]) {
  const commitActions = new ThreadCheckpointCommitActions();
  commitActions.setStored(proposalIds.map(stored), () => {});
  return renderToStaticMarkup(createElement(WorkbenchClientStateContext.Provider, { value: clientState(open) },
    createElement(ThreadGitArcProposalList, {
      acceptance: null,
      commitActions,
      cwd: "/repo",
      harness: "opencode",
      proposals: proposalIds.map(proposalId => ({ proposalId, status: "proposed" as const })),
      stackLayers: [],
      threadId: "thread",
    })));
}

function commitAllTag(html: string) {
  return html.match(/<button[^>]*data-thread-git-arc-commit-all="true"[^>]*>/u)?.[0] ?? null;
}

test("a collapsed proposals header keeps commit all available, including for a single proposal", () => {
  const two = renderList(false, ["one", "two"]);
  assert.doesNotMatch(two, /<details[^>]*\bopen=/u);
  const twoTag = commitAllTag(two);
  assert.ok(twoTag);
  assert.doesNotMatch(twoTag, / disabled=""/u);

  const one = renderList(false, ["only"]);
  const oneTag = commitAllTag(one);
  assert.ok(oneTag);
  assert.doesNotMatch(oneTag, / disabled=""/u);
});

test("an open proposals header leaves a single proposal to its own card", () => {
  const html = renderList(true, ["only"]);
  assert.match(html, /<details[^>]*\bopen=/u);
  assert.equal(commitAllTag(html), null);
});
