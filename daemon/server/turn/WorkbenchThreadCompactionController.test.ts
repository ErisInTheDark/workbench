/* No exports. Protect shared compaction admission, scope, failure settlement, in-admission queue delivery, generation handoff and stranded holds. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadAdmissionController, { WorkbenchAdmissionDrainingError } from "../thread/WorkbenchThreadAdmissionController";
import WorkbenchThreadCompactionController, {
  type CompactionQueueHandoff, type QueuedThreadMessage,
} from "./WorkbenchThreadCompactionController";

const threadId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const itemId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const admission = new WorkbenchThreadAdmissionController();
  const observations: Array<{ phase?: string }> = [];
  const steers: Array<{ entryKey: string; status: string; clientUserMessageId?: string | null; error: string | null }> = [];
  const retirements: string[] = [];
  const retired: Array<{ threadId: string; before: number }> = [];
  let stranded: string[] = [];
  const activity: boolean[] = [];
  const resolution = Promise.withResolvers<void>();
  const handoffs: CompactionQueueHandoff[] = [];
  let compact = async () => {};
  let handoff = async (_handoff: CompactionQueueHandoff) => {};
  const owner = new WorkbenchThreadCompactionController(admission, {
    itemId: () => itemId,
    now: () => observations.length + 1,
    record: async entries => {
      for (const entry of entries) {
        if (entry.kind === "contextCompaction") observations.push(entry);
        if (entry.kind === "steer") steers.push(entry.entry);
        if (entry.kind === "abandonedHolds") {
          retirements.push(entry.scope ?? "all");
          retired.push({ threadId: entry.threadId, before: entry.before });
        }
      }
      if (entries.some(entry => entry.kind === "steer" && entry.entry.status !== "pending")) resolution.resolve();
      return { changedThreadIds: [threadId], compactionCompletions: [] };
    },
    setCompacting: (_threadId, compacting) => { activity.push(compacting); },
    handoff: async (_threadId, next) => { handoffs.push(next); await handoff(next); },
    readStrandedThreadIds: async () => stranded,
  });
  const provider = { threads: {
    latestTurn: async () => ({ id: turnId }),
    compact: async () => compact(),
  } } as never;
  return {
    activity, admission, handoffs, observations, owner, provider, retired, retirements, steers,
    stranded: (threadIds: string[]) => { stranded = threadIds; },
    /** Resolves once the queue records its held messages' final state. */
    resolved: resolution.promise,
    compact: (next: () => Promise<void>) => { compact = next; },
    handoff: (next: (handoff: CompactionQueueHandoff) => Promise<void>) => { handoff = next; },
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

test("queued messages are admitted inside the compaction's own admission, ahead of input sent after it", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  const order: string[] = [];
  assert.equal(await f.owner.enqueue(threadId, message("first", "one"), async (_merged, ticket) => {
    assert.equal(f.admission.admits(threadId, ticket), true, "delivery reuses the admission its compaction holds");
    order.push("queued");
  }), true);
  const later = f.admission.run(threadId, async () => { order.push("later"); });
  held.release();
  await Promise.all([operation, later]);
  assert.deepEqual(order, ["queued", "later"]);
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending", "dismissed"]);
});

test("a generation retiring mid-compaction hands its queue to the current one with holds still pending", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  const deliver = async () => assert.fail("a retiring generation must not deliver into its own drained admission");
  await f.owner.enqueue(threadId, message("first", "one"), deliver);
  await f.owner.enqueue(threadId, message("second", "two"), deliver);
  f.owner.beginRuntimeDrain();
  held.release();
  await operation;
  assert.equal(f.handoffs.length, 1);
  const [handoff] = f.handoffs;
  assert.deepEqual(handoff!.messages.map(queued => queued.clientMessageId), ["first", "second"]);
  assert.equal(handoff!.compacted, true, "the adopter must not compact again");
  assert.equal(handoff!.queueId, f.steers[0]!.clientUserMessageId, "held copies keep naming the delivery");
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending", "pending"]);
});

test("delivery refused by a draining admission is handed off, not failed", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  await f.owner.enqueue(threadId, message("first", "one"), async () => {
    throw new WorkbenchAdmissionDrainingError("Auto-compaction admission");
  });
  held.release();
  await operation;
  assert.deepEqual(f.handoffs.map(handoff => handoff.compacted), [true]);
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending"]);
});

test("a queue no current generation can adopt is left undelivered for resend", async () => {
  const f = fixture();
  f.handoff(async () => { throw new Error("daemon is shutting down"); });
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  await f.owner.enqueue(threadId, message("first", "one"), async () => assert.fail("must not deliver"));
  f.owner.beginRuntimeDrain();
  held.release();
  await operation;
  await f.resolved;
  assert.deepEqual(f.steers.map(steer => steer.status), ["pending", "interrupted"]);
});

test("an adopted queue is delivered under its original id without compacting again", async () => {
  const f = fixture();
  f.compact(async () => assert.fail("already compacted"));
  const delivered: QueuedThreadMessage[] = [];
  await f.admission.run(threadId, ticket => f.owner.adopt(threadId, f.provider, ticket, {
    queueId: "queue", messages: [message("first", "one"), message("second", "two")], compacted: true,
  }, async merged => { delivered.push(merged); }));
  assert.deepEqual(delivered.map(merged => [merged.clientMessageId, merged.input.length]), [["queue", 2]]);
  assert.deepEqual(f.steers.map(steer => `${steer.entryKey}:${steer.status}`), [
    "compaction:first:pending", "compaction:second:pending", "compaction:first:dismissed", "compaction:second:dismissed",
  ]);
  assert.deepEqual(f.observations, []);
  assert.deepEqual(f.retirements, [], "its own holds are not stranded");
});

test("a starting generation retires every thread's stranded compaction holds except queues it already owns", async () => {
  const f = fixture();
  const other = "00000000-0000-4000-8000-000000000009";
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  f.retired.length = 0;
  f.stranded([threadId, other]);
  await f.owner.retireStrandedBefore(100);
  assert.deepEqual(f.retired, [{ threadId: other, before: 100 }], "the compacting thread's queue is owned");
  held.release();
  await operation;
});

test("stranded compaction holds are retired only while no queue owns the thread", async () => {
  const f = fixture();
  const held = heldCompaction(f);
  const operation = f.owner.compact(threadId, f.provider);
  await held.entered;
  assert.deepEqual(f.retirements, ["compactionQueue"], "a new compaction first retires what nobody owns");
  await f.owner.retireStranded(threadId);
  const delivering = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  await f.owner.enqueue(threadId, message("first", "one"), async () => { delivering.resolve(); await finish.promise; });
  held.release();
  await delivering.promise;
  await f.owner.retireStranded(threadId);
  assert.deepEqual(f.retirements, ["compactionQueue"], "compacting and delivering queues are owned");
  finish.resolve();
  await operation;
  await f.owner.retireStranded(threadId);
  assert.deepEqual(f.retirements, ["compactionQueue", "compactionQueue"]);
});
