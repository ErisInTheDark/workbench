/* No exports. Protect shared compaction admission, scope and failure settlement. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadCompactionController from "./WorkbenchThreadCompactionController";

const threadId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const itemId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const admission = new WorkbenchThreadAdmissionController();
  const observations: Array<{ phase?: string }> = [];
  const activity: boolean[] = [];
  let compact = async () => {};
  const owner = new WorkbenchThreadCompactionController(admission, {
    itemId: () => itemId,
    now: () => observations.length + 1,
    record: async entries => {
      for (const entry of entries) {
        if (entry.kind === "contextCompaction") observations.push(entry);
      }
      return { changedThreadIds: [threadId], compactionCompletions: [] };
    },
    setCompacting: (_threadId, compacting) => { activity.push(compacting); },
  });
  const provider = { threads: {
    latestTurn: async () => ({ id: turnId }),
    compact: async () => compact(),
  } } as never;
  return { activity, admission, observations, owner, provider, compact: (next: () => Promise<void>) => { compact = next; } };
}

test("admits the canonical marker before provider execution and fences queued messages", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.compact(async () => {
    assert.deepEqual(f.observations.map(entry => entry.phase), ["started"]);
    entered.resolve();
    await release.promise;
  });
  const operation = f.owner.compact(threadId, f.provider);
  await entered.promise;
  let admitted = false;
  const message = f.admission.run(threadId, async () => { admitted = true; });
  await Promise.resolve();
  assert.equal(admitted, false);
  release.resolve();
  await operation;
  await message;
  assert.equal(admitted, true);
  assert.deepEqual(f.activity, [true, false]);
});

test("settles provider failure and rejects overlapping compaction", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.compact(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("native failure");
  });
  const operation = f.owner.compact(threadId, f.provider);
  await entered.promise;
  await assert.rejects(f.owner.compact(threadId, f.provider), /already compacting/u);
  release.resolve();
  await assert.rejects(operation, /native failure/u);
  assert.deepEqual(f.observations.map(entry => entry.phase), ["started", "failed"]);
  assert.deepEqual(f.activity, [true, false]);
});
