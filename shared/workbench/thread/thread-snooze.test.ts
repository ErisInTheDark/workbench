/*
 * Exports: none. Tests protect app-owned snooze wake rules, dependent-target readiness and toggling, and the row overlay.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "../identity.ts";
import { WorkbenchThreadLifecycleSchema, type WorkbenchDurableQuestionnaire, type WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import { ThreadSnooze } from "./thread-snooze.ts";

type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;
type Question = WorkbenchDurableQuestionnaire;

function row(lifecycle: unknown, extra: Partial<Omit<ThreadEntry, "lifecycle" | "pendingQuestionnaire">> = {}): ThreadEntry {
  return {
    activityAt: 0, title: "Source", entryKind: "thread",
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse("source") },
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: WorkbenchThreadLifecycleSchema.parse(lifecycle),
    waitingOnThreads: [],
    ...extra,
  };
}
const working = (turnId: string) => ({ kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working", turnId } });
const completed = (turnId: string, settled = false) => ({
  kind: "completed", reason: "agentCompleted", settled, agent: { agentStatus: "completed", turnId },
});
const claims = { gitArc: {
  phase: "active", checkpointCommit: "a".repeat(40), proposals: [], claimedPaths: ["file.ts"], intentName: "work",
} } as unknown as Partial<ThreadEntry>;
const target = {
  identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("target") },
  projectId: ProjectIdSchema.parse("remote"), title: "Target",
};
const snoozeOf = (source: ThreadEntry, targets = [] as typeof target[]) => ({
  threadId: WorkbenchThreadIdSchema.parse("source"), basis: ThreadSnooze.capture(source), targets,
});

test("a working snooze wakes once the turn leaves working, however it ends", () => {
  const snooze = snoozeOf(row(working("t1")));
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(working("t1"))), false);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(completed("t1"))), true);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row({ kind: "needsAttention", reason: "pendingInput", requestKey: "q", settled: false })), true);
});

test("an idle snooze wakes on new work, even when the whole turn finished while nobody watched", () => {
  const snooze = snoozeOf(row(completed("t1")));
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(completed("t1"))), false);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(working("t2"))), true);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(completed("t2"))), true);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row({ kind: "stopped", reason: "userMarkedStopped", settled: false })), true);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(completed("t1", true))), true);
});

test("questionnaire snooze survives turn movement and wakes only when its question leaves", () => {
  const question = { itemId: "743c92b1-b79c-49d4-98a4-5b402bf6de6f", requestKey: "q", turnId: null, request: {
    id: "q", title: "Choose", summary: "", submitLabel: "Send",
    questions: [{ id: "c", header: "c", question: "Go?", options: [], allowOther: true, isSecret: false }],
  } } satisfies Question;
  const waiting = (turnId?: string): ThreadEntry => ({
    ...row(working("t1")), pendingQuestionnaire: question,
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "q", settled: false, ...(turnId ? { turnId: WorkbenchTurnIdSchema.parse(turnId) } : {}) },
  });
  const snooze = { ...snoozeOf(row(working("t1"))), basis: ThreadSnooze.capture(row(working("t1")), "q") };
  assert.equal(ThreadSnooze.isWakeDue(snooze, waiting()), false);
  assert.equal(ThreadSnooze.isWakeDue(snooze, waiting("t9")), false);
  assert.equal(ThreadSnooze.isWakeDue(snooze, row(working("t2"))), true);
});

test("ordinary snooze cannot keep idle claims, but a dependent snooze can", () => {
  const idle = row(completed("t1"));
  assert.equal(ThreadSnooze.isWakeDue(snoozeOf(idle), row(completed("t1"), claims)), true);
  assert.equal(ThreadSnooze.isWakeDue(snoozeOf(idle, [target]), row(completed("t1"), claims)), false);
});

test("targets are ready only once completed without live claims", () => {
  assert.equal(ThreadSnooze.isTargetReady(row(working("t1"))), false);
  assert.equal(ThreadSnooze.isTargetReady(row(completed("t1"), claims)), false);
  assert.equal(ThreadSnooze.isTargetReady(row(completed("t1"))), true);
});

test("toggling adds a waiting target, removes a held one, and ignores a ready one", () => {
  const source = row(completed("t1"));
  const added = ThreadSnooze.toggleTarget(null, source, target, false);
  assert.deepEqual(added?.targets, [target]);
  assert.equal(ThreadSnooze.toggleTarget(null, source, target, true), null);
  assert.equal(ThreadSnooze.toggleTarget(added, source, target, false), null);
});

test("the overlay decides snooze placement over a stale daemon flag", () => {
  const source = row(completed("t1"), { metadata: { archived: false, pinned: false, snoozed: true } });
  assert.equal(ThreadSnooze.apply(source, undefined).metadata.snoozed, false);
  const waiting = ThreadSnooze.apply(row(completed("t1")), snoozeOf(source, [target]));
  assert.equal(waiting.metadata.snoozed, true);
  assert.equal(waiting.waitingFor, "other");
  assert.deepEqual(waiting.waitingOnThreads, [target]);
  const unchanged = row(completed("t1"));
  assert.equal(ThreadSnooze.apply(unchanged, undefined), unchanged);
});
