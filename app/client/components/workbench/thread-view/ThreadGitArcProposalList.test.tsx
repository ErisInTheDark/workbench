/*
 * Exports:
 * - No production exports; tests protect commit-all availability in a collapsed proposals header and how accepted history groups by age.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { WorkbenchThreadGitCommit } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchClientStateController, { type WorkbenchClientStateSnapshot } from "../../../workbench/state/WorkbenchClientStateController";
import { threadGitCommitHistoryFor } from "../../../workbench/thread/ThreadGitCommitHistory";
import { WorkbenchClientStateContext } from "../workbench-client-state-context";
import { WorkbenchOperationsContext } from "../WorkbenchWorkspaceContext";
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

/** The daemon the list reads commit details from; `loaded` commits are already in its shared history. */
async function daemonWith(loaded: readonly WorkbenchThreadGitCommit[]) {
  // The transport edge answers raw JSON; the daemon facade validates it with the action's result schema.
  const daemon = new WorkbenchDaemonClient({ request: async <T,>() => ({ data: loaded }) as T });
  await threadGitCommitHistoryFor(daemon).load("thread", loaded);
  return daemon;
}

const refOf = ({ committedAt, commitSha, historyIndex, rootId }: WorkbenchThreadGitCommit) =>
  ({ ...(committedAt ? { committedAt } : {}), commitSha, historyIndex, rootId });

/** Bulk summaries stand in for cards that a collapsed header never lets load, so readiness is real. */
function renderList(
  open: boolean,
  proposalIds: readonly string[],
  status: "committed" | "proposed" = "proposed",
  history: WorkbenchThreadGitCommit[] = [],
  { standalone = false, daemon = null }: { standalone?: boolean; daemon?: WorkbenchDaemonClient | null } = {},
) {
  const commitActions = new ThreadCheckpointCommitActions();
  commitActions.setStored(status === "proposed" ? proposalIds.map(stored) : [], () => {});
  return renderToStaticMarkup(createElement(WorkbenchOperationsContext.Provider, { value: daemon },
    createElement(WorkbenchClientStateContext.Provider, { value: clientState(open) },
      createElement(ThreadGitArcProposalList, {
        acceptance: null,
        commitActions,
        cwd: "/repo",
        harness: "opencode",
        history: history.map(refOf),
        proposals: proposalIds.map(proposalId => ({ proposalId, status })),
        stackLayers: [],
        standalone,
        threadId: "thread",
      }))));
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

test("a lone proposal is its own disclosure, leaving commit to its open card", () => {
  const html = renderList(true, ["only"]);
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /aria-expanded="true"/u);
  assert.equal(commitAllTag(html), null);
});

const durableCommit = {
  commitSha: "a".repeat(40),
  description: "survives arc cleanup",
  historyIndex: 0,
  rootId: "root",
  sourceProposalId: "accepted",
  title: "durable commit",
};

test("accepted history alone opens straight onto closed commit rows", async () => {
  // A closed header preference must not hide history that has nothing to commit.
  const html = renderList(false, [], "committed", [durableCommit], { standalone: true, daemon: await daemonWith([durableCommit]) });
  assert.doesNotMatch(html, /data-thread-git-arc-accepted-group/u);
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /durable commit/u);
  assert.doesNotMatch(html, /survives arc cleanup/u);
  assert.equal(commitAllTag(html), null);
});

test("a durable commit row addresses its source proposal, so opening it can load amend state", async () => {
  const html = renderList(false, [], "committed", [durableCommit], { standalone: true, daemon: await daemonWith([durableCommit]) });
  assert.match(html, /data-thread-git-arc-proposal="accepted"/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /durable commit/u);
});

test("commit rows whose details have not loaded hold their place without inventing a source proposal", () => {
  const html = renderList(false, [], "committed", [durableCommit], { standalone: true, daemon: new WorkbenchDaemonClient({
    request: async () => { throw new Error("not read during a static render"); },
  }) });
  assert.match(html, new RegExp(`data-thread-git-commit="${durableCommit.commitSha}"`, "u"));
  assert.doesNotMatch(html, /data-thread-git-arc-proposal=/u);
  assert.doesNotMatch(html, /durable commit/u);
});

test("accepted history keeps its group when it shares the panel", () => {
  const withClaims = renderList(true, [], "committed", [durableCommit]);
  assert.match(withClaims, /data-thread-git-arc-accepted-group="older"/u);
  assert.match(withClaims, /1 commit/u);
  assert.equal(commitAllTag(withClaims), null);

  const withPending = renderList(true, ["pending"], "proposed", [durableCommit], { standalone: true });
  assert.match(withPending, /data-thread-git-arc-accepted-group="older"/u);
  assert.match(withPending, /1 commit, 1 proposal/u);
});

test("accepted history spanning several ages groups each age even when it is the whole panel", () => {
  const today = { ...durableCommit, committedAt: new Date().toISOString(), commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "today", title: "today commit" };
  const html = renderList(false, [], "committed", [durableCommit, today], { standalone: true });
  const groups = [...html.matchAll(/data-thread-git-arc-accepted-group="([a-z]+)"/gu)].map(([, bucket]) => bucket);
  assert.deepEqual(groups, ["older", "today"]);
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
  }], [duplicate, distinct].map(refOf));
  assert.equal(result.acceptedCount, 2);
  assert.deepEqual(result.historicalCommits, [refOf(distinct)]);
});
