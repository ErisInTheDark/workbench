/* No production exports. Tests protect orphaned-turn settlement on stop and on a cold daemon start, including stale-lifecycle repair and stalled providers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchTurnSettlementController, { type WorkbenchTurnSettlementOwners } from "./WorkbenchTurnSettlementController";

const projectId = ProjectIdSchema.parse("project");

function fixture({
  live = new Set<string>(), working = ["zombie", "running"], statuses = new Map<string, string>(),
  isTurnLive = async (threadId: string) => live.has(threadId),
} = {}) {
  const recorded: unknown[] = [];
  const lifecycles: unknown[] = [];
  const warnings: string[] = [];
  const settlements: string[] = [];
  const owners: WorkbenchTurnSettlementOwners = {
    providers: { get: () => ({ threads: { isTurnLive } }) as never },
    identities: { resolve: async ({ threadId }) => ({
      projectId, projectRoot: "C:/project", threadId: WorkbenchThreadIdSchema.parse(threadId),
      bindings: [{ harness: "claude", nativeLocation: "C:/project", nativeThreadId: NativeThreadIdSchema.parse(`native-${threadId}`), pending: false, turnIndex: 0 }],
    }) },
    transcripts: {
      readPage: async ({ threadId }) => ({ thread: { turns: [
        { id: `${threadId}-turn`, status: statuses.get(threadId) ?? "inProgress" },
      ] } }) as never,
      storedTurnSettlement: async (threadId, turnId) => {
        settlements.push(`${threadId}:${turnId}`);
        return [{ kind: "turn", turnId, state: "interrupted" }] as never;
      },
    },
    transcript: { record: async observations => { recorded.push(...observations); return undefined as never; } },
    observe: async (_harness, facts) => { lifecycles.push(facts.lifecycle); },
    listWorkingThreads: async () => working,
    warn: message => { warnings.push(message); },
  };
  return { controller: new WorkbenchTurnSettlementController(owners), owners, recorded, lifecycles, warnings, settlements };
}

test("stop settles a turn its provider no longer runs, and leaves live turns alone", async () => {
  const orphan = fixture();
  assert.equal(await orphan.controller.settleIfOrphaned("zombie", "zombie-turn"), true);
  assert.deepEqual(orphan.recorded, [{ kind: "turn", turnId: "zombie-turn", state: "interrupted" }]);
  assert.deepEqual(orphan.lifecycles, [{ threadId: "zombie", event: { kind: "turnCompleted", turnId: "zombie-turn", status: "interrupted" } }]);

  const live = fixture({ live: new Set(["running"]) });
  assert.equal(await live.controller.settleIfOrphaned("running", "running-turn"), false);
  assert.deepEqual([live.recorded, live.lifecycles, live.settlements], [[], [], []]);
});

test("an already-settled turn still has its stale working lifecycle published as interrupted", async () => {
  const f = fixture();
  f.owners.transcripts.storedTurnSettlement = async () => [];
  assert.equal(await f.controller.settleIfOrphaned("zombie", "zombie-turn"), true);
  assert.deepEqual(f.recorded, []);
  assert.equal(f.lifecycles.length, 1);
});

test("the cold sweep settles only dead working turns, once, and reports per-thread failures without stopping", async () => {
  const f = fixture({ live: new Set(["running"]), working: ["broken", "zombie", "running"] });
  const read = f.owners.transcripts.readPage;
  f.owners.transcripts.readPage = async input => {
    if (input.threadId === "broken") throw new Error("history unavailable");
    return read(input);
  };
  const first = f.controller.startColdSweep();
  assert.equal(f.controller.startColdSweep(), first);
  await first;
  assert.deepEqual(f.settlements, ["zombie:zombie-turn"]);
  assert.equal(f.warnings.filter(line => /broken.*history unavailable/u.test(line)).length, 1);
  assert.equal(f.warnings.filter(line => /Settled orphaned turn/u.test(line)).length, 1);
  assert.equal(f.warnings.filter(line => /checking 3 working thread\(s\)/u.test(line)).length, 1);
  assert.equal(f.warnings.filter(line => /finished: 1 settled, 0 ended turn\(s\) republished, 1 still running, 1 failed/u.test(line)).length, 1);
});

test("the cold sweep publishes a working thread's already-ended turn with its stored status, without settling it again", async () => {
  const f = fixture({ working: ["ended", "finished"], statuses: new Map([["ended", "interrupted"], ["finished", "completed"]]) });
  await f.controller.startColdSweep();
  assert.deepEqual(f.settlements, []);
  assert.deepEqual(f.lifecycles, [
    { threadId: "ended", event: { kind: "turnCompleted", turnId: "ended-turn", status: "interrupted" } },
    { threadId: "finished", event: { kind: "turnCompleted", turnId: "finished-turn", status: "completed" } },
  ]);
});

test("a provider whose liveness check never answers does not hold other threads' settlement back", async () => {
  const f = fixture({
    working: ["stalled", "zombie"],
    isTurnLive: threadId => threadId === "stalled" ? new Promise<boolean>(() => undefined) : Promise.resolve(false),
  });
  void f.controller.startColdSweep();
  for (let turn = 0; turn < 20 && !f.lifecycles.length; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.settlements, ["zombie:zombie-turn"]);
  assert.equal(f.lifecycles.length, 1);
});

test("retirement stops the sweep from settling anything further", async () => {
  const f = fixture({ working: ["zombie", "another"] });
  const read = f.owners.transcripts.readPage;
  f.owners.transcripts.readPage = async input => {
    await f.controller.dispose();
    return read(input);
  };
  await f.controller.startColdSweep();
  assert.deepEqual([f.settlements, f.lifecycles], [[], []]);
});
