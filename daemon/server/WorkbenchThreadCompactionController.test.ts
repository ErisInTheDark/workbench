/* No exports. Protect shared compaction admission, scope, failure settlement and the compaction queue. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadCompactionController, { type QueuedThreadMessage } from "./WorkbenchThreadCompactionController";

const threadId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const itemId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const admission = new WorkbenchThreadAdmissionController();
  const observations: Array<{ phase?: string }> = [];
  const steers: Array<{ entryKey: string; status: string; clientUserMessageId?: string | null; error: string | null }> = [];
  const activity: boolean[] = [];
  const resolution = Promise.withResolvers<void>();
  let compact = async () => {};
  const owner = new WorkbenchThreadCompactionController(admission, {
    itemId: () => itemId,
    now: () => observations.length + 1,
    record: async entries => {
      for (const entry of entries) {
        if (entry.kind === "contextCompaction") observations.push(entry);
        if (entry.kind === "steer") steers.push(entry.entry);
      }
      if (entries.some(entry => entry.kind === "steer" && entry.entry.status !== "pending")) resolution.resolve();
      return { changedThreadIds: [threadId], compactionCompletions: [] };
    },
    setCompacting: (_threadId, compacting) => { activity.push(compacting); },
  });
  const provider = { threads: {
    latestTurn: async () => ({ id: turnId }),
    compact: async () => compact(),
  } } as never;
  return {
    activity, admission, observations, owner, provider, steers,
    /** Resolves once the queue records its held messages' final state. */
    resolved: resolution.promise,
    compact: (next: () => Promise<void>) => { compact = next; },
  };
}

function message(clientMessageId: string, text: string, context?: QueuedThreadMessage["context"]): QueuedThreadMessage {
  return { clientMessageId, intent: "continue", input: [{ type: "text", text, text_elements: [] }], ...(context ? { context } : {}) };
}

/** Holds compaction open until released; `failure` makes the native compaction fail on release. */
function heldCompaction(f: ReturnType<typeof fixture>, failure?: Error) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.compact(async () => {
    entered.resolve();
    await release.promise;
    if (failure) throw failure;
  });
  return { entered: entered.promise, release: release.resolve };
}

test("messages sent during compaction are held, then delivered once as one merged message", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  const delivered: QueuedThreadMessage[] = [];
  const deliver = async (merged: QueuedThreadMessage) => { delivered.push(merged); };
  assert.equal(await f.owner.enqueue(threadId, message("first", "one", { activatedSkillPaths: ["a"], workflowIds: ["default"] }), deliver), true);
  assert.equal(await f.owner.enqueue(threadId, message("second", "two", { activatedSkillPaths: ["b", "a"] }), deliver), true);
  assert.deepEqual(f.steers.map(steer => [steer.entryKey, steer.status]), [["compaction:first", "pending"], ["compaction:second", "pending"]]);
  assert.deepEqual(delivered, [], "nothing reaches the agent while compaction runs");

  held.release();
  await operation;
  await f.resolved;
  assert.equal(delivered.length, 1);
  const [merged] = delivered;
  assert.deepEqual(merged!.input.map(part => part.type === "text" ? part.text : part.type), ["one", "two"]);
  assert.deepEqual(merged!.context, { workflowIds: ["default"] }, "admission activates skills from the merged input");
  // Every held copy names the merged message, so clients hide them once it lands.
  assert.ok(f.steers.every(steer => steer.clientUserMessageId === merged!.clientMessageId));
  assert.deepEqual(f.steers.slice(2).map(steer => [steer.entryKey, steer.status]), [["compaction:first", "dismissed"], ["compaction:second", "dismissed"]]);
});

test("nothing queues when no compaction runs, or after it ends", async () => {
  const f = fixture();
  const deliver = async () => assert.fail("no queue to deliver");
  assert.equal(await f.owner.enqueue(threadId, message("early", "x"), deliver), false);
  await f.owner.compact(threadId, f.provider);
  assert.equal(await f.owner.enqueue(threadId, message("late", "x"), deliver), false);
  assert.deepEqual(f.steers, []);
});

test("failed compaction leaves queued messages undelivered instead of sending them", async () => {
  const f = fixture();
  const held = heldCompaction(f, new Error("native failure"));
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  assert.equal(await f.owner.enqueue(threadId, message("first", "one"), async () => assert.fail("must not deliver")), true);
  held.release();
  await assert.rejects(operation, /native failure/u);
  await f.resolved;
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending", "failed"]);
  assert.match(f.steers[1]!.error ?? "", /compaction failed/iu);
});

test("failed delivery after compaction leaves queued messages undelivered with the cause", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  assert.equal(await f.owner.enqueue(threadId, message("first", "one"), async () => { throw new Error("provider unavailable"); }), true);
  held.release();
  await operation;
  await f.resolved;
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending", "failed"]);
  assert.equal(f.steers[1]!.error, "provider unavailable");
});

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
