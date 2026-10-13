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
import ThreadGitArcProposalList, { getThreadAcceptedGitHistory } from "./ThreadGitArcProposalList";

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
function renderList(
  open: boolean,
  proposalIds: readonly string[],
  status: "committed" | "proposed" = "proposed",
  history: Array<{
    commitSha: string;
    description: string;
    historyIndex: number;
    rootId: string;
    sourceProposalId: string;
    title: string;
  }> = [],
) {
  const commitActions = new ThreadCheckpointCommitActions();
  commitActions.setStored(status === "proposed" ? proposalIds.map(stored) : [], () => {});
  return renderToStaticMarkup(createElement(WorkbenchClientStateContext.Provider, { value: clientState(open) },
    createElement(ThreadGitArcProposalList, {
      acceptance: null,
      commitActions,
      cwd: "/repo",
      harness: "opencode",
      history,
      proposals: proposalIds.map(proposalId => ({ proposalId, status })),
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

test("accepted-only history renders its accepted disclosure without commit all", () => {
  const html = renderList(true, ["one", "two"], "committed");
  assert.match(html, /data-thread-git-arc-accepted-group="true"/u);
  assert.match(html, /Accepted/u);
  assert.equal(commitAllTag(html), null);
});

test("durable accepted history renders without proposals", () => {
  const html = renderList(true, [], "committed", [{
    commitSha: "a".repeat(40),
    description: "survives arc cleanup",
    historyIndex: 0,
    rootId: "root",
    sourceProposalId: "accepted",
    title: "durable commit",
  }]);
  assert.match(html, /data-thread-git-arc-accepted-group="true"/u);
  assert.match(html, /1 commit/u);
  assert.equal(commitAllTag(html), null);
});

test("live accepted proposals win over duplicate durable commits", () => {
  const duplicate = {
    commitSha: "a".repeat(40),
    description: "durable copy",
    historyIndex: 0,
    rootId: "root",
    sourceProposalId: "proposal",
    title: "durable copy",
  };
  const distinct = { ...duplicate, commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "other" };
  const result = getThreadAcceptedGitHistory([{
    proposalId: "proposal",
    rootId: "root",
    status: "committed",
    summary: {
      changes: null,
      committedSha: duplicate.commitSha,
      description: "live copy",
      mode: "commit",
      title: "live copy",
    },
  }], [duplicate, distinct]);
  assert.equal(result.acceptedCount, 2);
  assert.deepEqual(result.historicalCommits, [distinct]);
});
