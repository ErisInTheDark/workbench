/*
 * Exports: none. Protect compact status protocol semantics and literal round-trips.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatGitArcStatus, parseGitArcStatus, type GitArcStatus } from "./git-arc-status";

const empty: GitArcStatus = {
  pending: [], accepted: [], dirtyClaims: [], cleanClaims: [], unclaimedDirt: [], recovery: [], unavailableRecovery: [],
};

test("compact status preserves counts separately from expanded and ambiguous literal paths", () => {
  const dirtyClaims = ["1", "comma, file", '"quoted"', "line\nbreak", "ordinary", "last"];
  const input = { ...empty, dirtyClaims, cleanClaims: dirtyClaims.slice(0, 5), unclaimedDirt: dirtyClaims };
  const compact = parseGitArcStatus(formatGitArcStatus(input));
  assert.ok(compact.success);
  assert.equal(compact.data.dirtyClaims, 6);
  assert.deepEqual(compact.data.cleanClaims, dirtyClaims.slice(0, 5));
  const expanded = parseGitArcStatus(formatGitArcStatus(input, ["dirty"]));
  assert.ok(expanded.success);
  assert.deepEqual(expanded.data.dirtyClaims, dirtyClaims);
  assert.equal(expanded.data.unclaimedDirt, 6);
  assert.equal(formatGitArcStatus(empty), "");
  assert.deepEqual(parseGitArcStatus("").data, empty);
});

test("status round-trips proposal identities and recovery counts without section injection", () => {
  const input: GitArcStatus = {
    ...empty,
    pending: [{ proposalId: "pending", title: "commas, quotes \" and\nDirty claims: fake" }],
    accepted: [{ proposalId: "accepted", title: "words as words", commitSha: "a".repeat(40) }],
    recovery: [{
      paths: ["comma, file"], headMovement: "incompatible", commits: [{
        commit: "b".repeat(40), subject: "comma, subject", changedPaths: [],
      }], omittedCommits: 2,
      comparison: [{ path: "tab\tfile", additions: 0, deletions: 0, kind: "update", binary: true }],
    }],
  };
  const parsed = parseGitArcStatus(formatGitArcStatus(input));
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, input);
  assert.deepEqual(parseGitArcStatus(formatGitArcStatus(input).replaceAll("\n", "\r\n")).data, input);
  assert.equal(parseGitArcStatus("Dirty claims: one\nDirty claims: two").success, false);
  assert.equal(parseGitArcStatus('Dirty claims: "unterminated').success, false);
});

test("incomplete recovery never reports an unchanged boundary", () => {
  assert.equal(parseGitArcStatus("Lost claims: one").success, false);
});
