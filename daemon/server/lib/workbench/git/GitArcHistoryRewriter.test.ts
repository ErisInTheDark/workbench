/*
 * Exports: none. Tests protect frozen stash merge bases during history remapping.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { remapGitArcClaimLossHead } from "./GitArcHistoryRewriter";

test("history remapping preserves frozen stash bases and advances ordinary loss boundaries", () => {
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const commits = new Map([[oldHead, newHead]]);
  assert.equal(remapGitArcClaimLossHead({ frozen: true, head: oldHead }, commits), oldHead);
  assert.equal(remapGitArcClaimLossHead({ frozen: false, head: oldHead }, commits), newHead);
  assert.equal(remapGitArcClaimLossHead({ frozen: true, head: null }, commits), null);
});
