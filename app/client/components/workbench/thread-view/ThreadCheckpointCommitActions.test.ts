/* No production exports. Regression wards cover one ordered batch, per-card outcomes, failure stops, readiness gating, and stored versus loaded choices. */

import assert from "node:assert/strict";
import test from "node:test";

import type { GitArcProposalCommitEntry, GitArcProposalCommitManyResult, GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { createGitArcOperationRejected, GitArcFailureException } from "workbench-shared/workbench/git/git-arc-failures";
import ThreadCheckpointCommitActions, { type ThreadCheckpointCommitOutcome } from "./ThreadCheckpointCommitActions";

const landed = (proposalId: string) => ({ proposalId, status: "committed" }) as GitCheckpointProposal;
const entry = (proposalId: string, title = proposalId): GitArcProposalCommitEntry => ({ description: "", includeNewer: false, proposalId, title });

function card(proposalId: string, outcomes: string[], overrides: { loaded?: boolean; ready?: boolean; title?: string } = {}) {
  return {
    entry: () => entry(proposalId, overrides.title),
    loaded: overrides.loaded,
    ready: overrides.ready ?? true,
    settle: (outcome: ThreadCheckpointCommitOutcome) => {
      outcomes.push("proposal" in outcome ? `${proposalId}:landed` : `${proposalId}:${(outcome.error as Error).message}`);
    },
  };
}

test("commit all sends every card's choices in order as one batch and settles each landed card", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const outcomes: string[] = [];
  actions.register("one", card("one", outcomes, { title: "edited title" }));
  actions.register("two", card("two", outcomes));
  const requests: GitArcProposalCommitEntry[][] = [];
  const result = await actions.commitAll(["one", "two"], async (entries) => {
    requests.push(entries);
    return { failed: null, landed: [landed("one"), landed("two")] };
  });
  assert.equal(result, true);
  assert.deepEqual(requests.map(entries => entries.map(({ proposalId, title }) => `${proposalId}:${title}`)), [["one:edited title", "two:two"]]);
  assert.deepEqual(outcomes, ["one:landed", "two:landed"]);
});

test("commit all shows the first failure on its own card, after the landed ones", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const outcomes: string[] = [];
  for (const id of ["one", "two", "three"]) actions.register(id, card(id, outcomes));
  const failure = createGitArcOperationRejected("proposalCommit", "two broke");
  const result: GitArcProposalCommitManyResult = { failed: { failure, proposalId: "two" }, landed: [landed("one")] };
  assert.equal(await actions.commitAll(["one", "two", "three"], async () => result), false);
  assert.deepEqual(outcomes, ["one:landed", `two:${new GitArcFailureException(failure).message}`]);
});

test("a batch that fails as a whole reports on the first card", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const outcomes: string[] = [];
  for (const id of ["one", "two"]) actions.register(id, card(id, outcomes));
  assert.equal(await actions.commitAll(["one", "two"], async () => { throw new Error("socket closed"); }), false);
  assert.deepEqual(outcomes, ["one:socket closed"]);
});

test("commit all starts only when every proposal is ready", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const outcomes: string[] = [];
  actions.register("one", card("one", outcomes));
  actions.register("two", card("two", outcomes, { ready: false }));
  let requested = false;
  assert.equal(actions.isReady(["one", "two"]), false);
  assert.equal(await actions.commitAll(["one", "two"], async () => { requested = true; return { failed: null, landed: [] }; }), false);
  assert.equal(requested, false);
});

const summary = (proposalId: string, overrides: Partial<{ hasChanges: boolean; status: "proposed" | "committed"; title: string }> = {}) => ({
  description: `${proposalId} why`, hasChanges: true, mode: "commit" as const, proposalId, status: "proposed" as const, title: proposalId, ...overrides,
});

test("unloaded proposals commit their stored message while loaded cards keep their own, and outcomes reach the right tier", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const outcomes: string[] = [];
  // Each landed commit changes the pending set, so the list releases its summaries to refetch mid-run.
  const release = actions.setStored([summary("one"), summary("two"), summary("three")], ({ proposalId }, outcome) => {
    outcomes.push(`stored:${proposalId}:${"proposal" in outcome ? "landed" : "failed"}`);
    release();
  });
  // Collapsed layers mount cards that never loaded; their registrations must not hide the summary.
  actions.register("one", card("one", outcomes, { loaded: false, ready: false }));
  actions.register("two", card("two", outcomes, { loaded: true, title: "card title" }));
  assert.equal(actions.isReady(["one", "two", "three"]), true);
  let sent: GitArcProposalCommitEntry[] = [];
  assert.equal(await actions.commitAll(["one", "two", "three"], async (entries) => {
    sent = entries;
    return { failed: null, landed: [landed("one"), landed("two"), landed("three")] };
  }), true);
  assert.deepEqual(sent.map(({ description, title }) => `${title}|${description}`), ["one|one why", "card title|", "three|three why"]);
  assert.deepEqual(outcomes, ["stored:one:landed", "two:landed", "stored:three:landed"]);
});

test("a stored summary without changes, without a title or no longer proposed is not ready", () => {
  const actions = new ThreadCheckpointCommitActions();
  actions.setStored([
    summary("empty", { hasChanges: false }), summary("untitled", { title: " " }), summary("landed", { status: "committed" }),
  ], () => {});
  for (const id of ["empty", "untitled", "landed"]) assert.equal(actions.isReady([id]), false, id);
});

test("a replaced registration survives the stale cleanup", () => {
  const actions = new ThreadCheckpointCommitActions();
  const stale = actions.register("one", card("one", [], { ready: false }));
  actions.register("one", card("one", []));
  stale();
  assert.equal(actions.isReady(["one"]), true);
});
