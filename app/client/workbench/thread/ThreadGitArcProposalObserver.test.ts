/*
 * Exports:
 * - No production exports; tests protect separately demanded proposal read variants and their lifecycle refresh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import ThreadGitArcProposalObserver, { getThreadGitArcProposalObservationKey } from "./ThreadGitArcProposalObserver";

type Entry = Parameters<ThreadGitArcProposalObserver["sync"]>[0];
type ReadInput = Parameters<NonNullable<ConstructorParameters<typeof ThreadGitArcProposalObserver>[0]["read"]>>[0];

function entry(checkpoint: string): Entry {
  return {
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: { kind: "completed", reason: "agentCompleted", settled: false },
    gitArc: {
      checkpointCommit: checkpoint.repeat(40), claimedPaths: ["src/a.ts"], intentDescription: "", intentName: "work",
      phase: "active", proposals: [{ proposalId: "p", status: "proposed" }], updatedAt: "2026-10-11",
    },
  } as unknown as Entry;
}

async function settle() {
  for (let tick = 0; tick < 3; tick++) await Promise.resolve();
}

test("a read variant is observed beside the plain read, with its own inclusions, and both refresh on lifecycle changes", async () => {
  const reads: ReadInput[] = [];
  const observer = new ThreadGitArcProposalObserver({
    read: async (input) => {
      reads.push(input);
      return { proposalId: input.proposalId, title: input.includeNewer ? "with newer" : "plain" } as never;
    },
    changed: () => {},
    isLive: () => true,
  });
  const variantKey = getThreadGitArcProposalObservationKey("p", { includeNewer: true });
  observer.demand("p");
  const releaseVariant = observer.demand("p", { includeNewer: true });
  observer.sync(entry("a"), "/repo");
  await settle();

  assert.deepEqual(reads.map(({ includeNewer, includeUnclaimed }) => [includeNewer, includeUnclaimed]), [[false, false], [true, false]]);
  const titles = Object.fromEntries(Object.entries(observer.proposals).map(([key, state]) => [key, state.status === "loaded" ? state.proposal.title : state.status]));
  assert.deepEqual(titles, { p: "plain", [variantKey]: "with newer" });

  releaseVariant();
  observer.sync(entry("b"), "/repo");
  await settle();
  assert.equal(reads.length, 3, "only the still-demanded plain read refreshes");
  assert.equal(reads[2]!.includeNewer, false);
  assert.deepEqual(Object.keys(observer.proposals), ["p"]);
});
