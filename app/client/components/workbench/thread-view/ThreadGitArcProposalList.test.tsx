/*
 * Exports:
 * - No production exports; tests protect commit-all availability in a collapsed proposals header, and how accepted history loads, dedupes and groups by age.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import {
  getWorkbenchThreadGitCommitHistory, type WorkbenchGitArcProposalState, type WorkbenchThreadGitCommit,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchClientStateController, { type WorkbenchClientStateSnapshot } from "../../../workbench/state/WorkbenchClientStateController";
import { threadGitCommitHistoryFor } from "../../../workbench/thread/ThreadGitCommitHistory";
import { WorkbenchClientStateContext } from "../workbench-client-state-context";
import { WorkbenchOperationsContext } from "../WorkbenchWorkspaceContext";
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

const refOf = ({ committedAt, commitSha, historyIndex, rootId }: WorkbenchThreadGitCommit) =>
  ({ ...(committedAt ? { committedAt } : {}), commitSha, historyIndex, rootId });

type Preload = "loaded" | "failed" | "unread";

/**
 * The daemon the list reads refs and commit details from. A static render runs no effects, so `refs` and `details`
 * say what its shared store already holds when the list renders: loaded, failed to load, or never asked for.
 */
async function daemonWith(history: readonly WorkbenchThreadGitCommit[], { details = "loaded", refs = "loaded" }: {
  details?: Preload; refs?: Preload;
} = {}) {
  // The transport edge answers raw JSON; the daemon facade validates it with the action's result schema.
  const daemon = new WorkbenchDaemonClient({ request: async <T,>(method: string) => {
    if (method === "thread/git-commit-refs/read" && refs === "loaded") return { data: history.map(refOf) } as T;
    if (method === "thread/git-commits/read" && details === "loaded") return { data: history } as T;
    throw new Error("{\"code\":\"unrecognized_keys\"}");
  } });
  const store = threadGitCommitHistoryFor(daemon);
  if (refs !== "unread") await store.loadRefs("thread", historyOf(history, []).revision);
  if (details !== "unread") await store.load("thread", history);
  return daemon;
}

const historyOf = (history: readonly WorkbenchThreadGitCommit[], proposals: readonly WorkbenchGitArcProposalState[]) =>
  getWorkbenchThreadGitCommitHistory(history.map(refOf), proposals);

/** Bulk summaries stand in for cards that a collapsed header never lets load, so readiness is real. */
async function renderList(
  open: boolean,
  proposalIds: readonly string[],
  status: "committed" | "proposed" = "proposed",
  history: WorkbenchThreadGitCommit[] = [],
  { standalone = false, daemon, proposals = proposalIds.map(proposalId => ({ proposalId, status })) }: {
    standalone?: boolean; daemon?: WorkbenchDaemonClient; proposals?: WorkbenchGitArcProposalState[];
  } = {},
) {
  const commitActions = new ThreadCheckpointCommitActions();
  commitActions.setStored(status === "proposed" ? proposalIds.map(stored) : [], () => {});
  return renderToStaticMarkup(createElement(WorkbenchOperationsContext.Provider, { value: daemon ?? await daemonWith(history) },
    createElement(WorkbenchClientStateContext.Provider, { value: clientState(open) },
      createElement(ThreadGitArcProposalList, {
        acceptance: null,
        commitActions,
        cwd: "/repo",
        harness: "opencode",
        ...(history.length ? { history: historyOf(history, proposals) } : {}),
        proposals,
        stackLayers: [],
        standalone,
        threadId: "thread",
      }))));
}

function commitAllTag(html: string) {
  return html.match(/<button[^>]*data-thread-git-arc-commit-all="true"[^>]*>/u)?.[0] ?? null;
}

test("a collapsed proposals header keeps commit all available, including for a single proposal", async () => {
  const two = await renderList(false, ["one", "two"]);
  assert.doesNotMatch(two, /<details[^>]*\bopen=/u);
  const twoTag = commitAllTag(two);
  assert.ok(twoTag);
  assert.doesNotMatch(twoTag, / disabled=""/u);

  const one = await renderList(false, ["only"]);
  const oneTag = commitAllTag(one);
  assert.ok(oneTag);
  assert.doesNotMatch(oneTag, / disabled=""/u);
});

test("a lone proposal is its own disclosure, leaving commit to its open card", async () => {
  const html = await renderList(true, ["only"]);
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
  const html = await renderList(false, [], "committed", [durableCommit], { standalone: true });
  assert.doesNotMatch(html, /data-thread-git-arc-accepted-group/u);
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /durable commit/u);
  assert.doesNotMatch(html, /survives arc cleanup/u);
  assert.equal(commitAllTag(html), null);
});

test("a durable commit row addresses its source proposal, so opening it can load amend state", async () => {
  const html = await renderList(false, [], "committed", [durableCommit], { standalone: true });
  assert.match(html, /data-thread-git-arc-proposal="accepted"/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /durable commit/u);
});

test("commit rows whose details have not loaded hold their place without inventing a source proposal", async () => {
  const daemon = await daemonWith([durableCommit], { details: "unread" });
  const html = await renderList(false, [], "committed", [durableCommit], { standalone: true, daemon });
  assert.match(html, new RegExp(`data-thread-git-commit="${durableCommit.commitSha}"`, "u"));
  assert.doesNotMatch(html, /data-thread-git-arc-proposal=/u);
  assert.doesNotMatch(html, /durable commit/u);
});

test("commits whose details failed share one short notice with a retry, not an error per row", async context => {
  const reports: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => { reports.push(args); });
  const other = { ...durableCommit, commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "other", title: "other" };
  const daemon = await daemonWith([durableCommit, other], { details: "failed" });
  const html = await renderList(false, [], "committed", [durableCommit, other], { standalone: true, daemon });
  assert.equal(html.match(/role="alert"/gu)?.length, 1);
  assert.match(html, /data-thread-git-commit-retry="true"/u);
  assert.doesNotMatch(html, /unrecognized_keys/u);
  assert.equal(reports.length, 1, "the cause is logged once for the whole read");
});

test("recorded history counts in the header before its refs arrive, and a failed ref read offers one retry", async context => {
  context.mock.method(console, "error", () => {});
  const other = { ...durableCommit, commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "other", title: "other" };
  const loading = await renderList(true, ["pending"], "proposed", [durableCommit, other], {
    daemon: await daemonWith([durableCommit, other], { details: "unread", refs: "unread" }),
  });
  assert.match(loading, /2 commits, 1 proposal/u);
  assert.match(loading, /data-thread-git-commit-history-loading="true"/u);
  assert.doesNotMatch(loading, /data-thread-git-arc-accepted-group/u);

  const failed = await renderList(true, ["pending"], "proposed", [durableCommit, other], {
    daemon: await daemonWith([durableCommit, other], { details: "unread", refs: "failed" }),
  });
  assert.match(failed, /2 commits, 1 proposal/u);
  assert.equal(failed.match(/data-thread-git-commit-retry="true"/gu)?.length, 1);
});

test("accepted history keeps its group when it shares the panel", async () => {
  const withClaims = await renderList(true, [], "committed", [durableCommit]);
  assert.match(withClaims, /data-thread-git-arc-accepted-group="older"/u);
  assert.match(withClaims, /1 commit/u);
  assert.equal(commitAllTag(withClaims), null);

  const withPending = await renderList(true, ["pending"], "proposed", [durableCommit], { standalone: true });
  assert.match(withPending, /data-thread-git-arc-accepted-group="older"/u);
  assert.match(withPending, /1 commit, 1 proposal/u);
});

test("accepted history spanning several ages groups each age even when it is the whole panel", async () => {
  const today = { ...durableCommit, committedAt: new Date().toISOString(), commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "today", title: "today commit" };
  const html = await renderList(false, [], "committed", [durableCommit, today], { standalone: true });
  const groups = [...html.matchAll(/data-thread-git-arc-accepted-group="([a-z]+)"/gu)].map(([, bucket]) => bucket);
  assert.deepEqual(groups, ["older", "today"]);
});

test("live accepted proposals win over duplicate durable commits", async () => {
  const duplicate = { ...durableCommit, description: "durable copy", sourceProposalId: "proposal", title: "durable copy" };
  const distinct = { ...duplicate, commitSha: "b".repeat(40), historyIndex: 1, sourceProposalId: "other" };
  const html = await renderList(true, [], "committed", [duplicate, distinct], { standalone: true, proposals: [{
    proposalId: "proposal",
    rootId: "root",
    status: "committed",
    summary: { changes: null, committedSha: duplicate.commitSha, description: "live copy", mode: "commit", title: "live copy" },
  }] });
  assert.equal(html.match(/data-thread-git-arc-proposal="proposal"/gu)?.length, 1, "the live proposal shows once");
  assert.match(html, new RegExp(`data-thread-git-commit="${distinct.commitSha}"`, "u"));
  assert.doesNotMatch(html, new RegExp(`data-thread-git-commit="${duplicate.commitSha}"`, "u"));
});
