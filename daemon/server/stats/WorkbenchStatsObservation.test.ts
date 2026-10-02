/*
 * No exports. Protect staged publication, coalesced invalidation, history reuse, and release of one stats observation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchClaimRenameRead } from "./WorkbenchClaimRenameController.ts";
import WorkbenchStatsObservation, { type WorkbenchStatsObservationState } from "./WorkbenchStatsObservation.ts";

const request = { projectIds: null, range: "7d" as const };
const rename = { projectId: "project", rootId: "root", from: "old", to: "new" };

/** Hands each pushed item to exactly one `next()` caller, in order, buffering items nobody awaits yet. */
function channel<T>() {
  const items: T[] = [];
  const waiting: Array<(item: T) => void> = [];
  let consumed = 0;
  return {
    all: items,
    push(item: T) {
      items.push(item);
      const waiter = waiting.shift();
      if (!waiter) return;
      consumed += 1;
      waiter(item);
    },
    next(): Promise<T> {
      if (consumed < items.length) return Promise.resolve(items[consumed++]!);
      return new Promise<T>((resolve) => waiting.push(resolve));
    },
  };
}

function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { open = resolve; });
  return { promise, open };
}

function harness() {
  const reads = channel<{ renames: number; release: () => void }>();
  const walks = channel<(history: WorkbenchClaimRenameRead) => void>();
  const states = channel<WorkbenchStatsObservationState>();
  const observation = new WorkbenchStatsObservation(request, {
    read: async (_request, history) => {
      const opened = gate<void>();
      reads.push({ renames: history.renames.length, release: () => opened.open() });
      await opened.promise;
      return { generatedAt: reads.all.length, claimHotspots: [] } as unknown as WorkbenchStatsResponse;
    },
    readRenames: async () => {
      const walked = gate<WorkbenchClaimRenameRead>();
      walks.push(walked.open);
      return await walked.promise;
    },
    warn: () => undefined,
  }, (state) => states.push(state));
  return { observation, reads, walks, states };
}

test("usage publishes before rename history, then claims publish with the merged aliases", async () => {
  const { observation, reads, walks, states } = harness();
  const usageRead = reads.next();
  observation.start();
  (await usageRead).release();
  const usage = await states.next();
  assert.deepEqual([usage.phase, usage.claimsPhase], ["current", "pending"]);
  const walk = await walks.next();
  const claimsRead = reads.next();
  walk({ renames: [rename], failures: [] });
  const merged = await claimsRead;
  assert.equal(merged.renames, 1, "claims re-read with the walked aliases");
  const claims = states.next();
  merged.release();
  assert.equal((await claims).claimsPhase, "current");
});

test("invalidations during a read collapse into one follow-up that reuses known history", async () => {
  const { observation, reads, walks, states } = harness();
  const first = reads.next();
  observation.start();
  (await first).release();
  const walk = await walks.next();
  const settledClaims = states.next().then(() => states.next());
  walk({ renames: [], failures: [] });
  await settledClaims;
  await observation.settled;

  const inFlight = reads.next();
  observation.invalidate("usage");
  const busy = await inFlight;
  for (let burst = 0; burst < 5; burst += 1) observation.invalidate("usage");
  const followUp = reads.next();
  busy.release();
  (await followUp).release();
  await observation.settled;
  assert.equal(reads.all.length, 3, "five invalidations during one read cause exactly one follow-up");
  assert.equal(walks.all.length, 1, "usage invalidations never re-walk Git history");
});

test("released observations stop reading and publishing", async () => {
  const { observation, reads, walks, states } = harness();
  const first = reads.next();
  observation.start();
  const pending = await first;
  observation.release();
  pending.release();
  await observation.settled;
  observation.invalidate("claims");
  await observation.settled;
  assert.deepEqual(states.all, []);
  assert.equal(reads.all.length, 1);
  assert.equal(walks.all.length, 0);
});
