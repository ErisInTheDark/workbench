/*
 * Exports: none. Tests protect subagent queue turn order, pauses, freezes, handoffs and reload retention.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadLifecycle, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { isWorkbenchAgentMcpRuntimeReloadInterruption } from "./lib/workbench/commands/workbench-agent-command-definition";
import WorkbenchSubagentQueueController, { type WorkbenchSubagentQueueHandoff } from "./WorkbenchSubagentQueueController";

const projectId = "project" as ProjectId;
const parent = "parent-thread" as WorkbenchThreadId;
const [ada, bram, cleo] = ["ada", "bram", "cleo"].map(name => `${name}-thread` as WorkbenchThreadId);

const working: WorkbenchThreadLifecycle = { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false };
const turnEnded: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };
const completed: WorkbenchThreadLifecycle = { agent: { agentStatus: "completed" }, kind: "completed", reason: "agentCompleted", settled: false };
const stopped: WorkbenchThreadLifecycle = { kind: "stopped", reason: "userMarkedStopped", settled: false };
const questionnaire: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "pendingInput", requestKey: "q", settled: false };

function child(threadId: WorkbenchThreadId) {
  return { name: threadId.replace("-thread", ""), parentThreadId: parent, projectId, threadId } as WorkbenchSubagentRelationship;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function track(promise: Promise<string>) {
  const state: { text: string | null; error: unknown } = { text: null, error: null };
  promise.then(text => { state.text = text; }, (error: unknown) => { state.error = error; });
  return state;
}

function createHarness(handoff?: WorkbenchSubagentQueueHandoff) {
  const listeners = new Set<(projectId: string, entry: WorkbenchThreadSidebarEntry) => void>();
  const lifecycles = new Map<string, WorkbenchThreadLifecycle>();
  const notices: Array<{ threadId: string; message: string }> = [];
  const warnings: string[] = [];
  const controller = new WorkbenchSubagentQueueController({
    resolveProjectFromCwd: async () => projectId,
    resolveThreadId: async threadId => threadId as WorkbenchThreadId,
    listRelationships: async () => [child(ada), child(bram), child(cleo)],
    readLifecycle: async (_projectId, threadId) => lifecycles.get(threadId) ?? working,
    subscribeLifecycle: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sendNotice: async ({ threadId, message }) => { notices.push({ threadId, message }); },
    warn: message => { warnings.push(message); },
    now: () => 1_000,
  }, handoff);
  const emit = (threadId: WorkbenchThreadId, lifecycle: WorkbenchThreadLifecycle) => {
    lifecycles.set(threadId, lifecycle);
    const entry = { entryKind: "subagent", identity: { harness: "codex", threadId }, lifecycle } as unknown as WorkbenchThreadSidebarEntry;
    for (const listener of listeners) listener(projectId, entry);
  };
  const queue = (caller: WorkbenchThreadId, input: Record<string, string> = {}, signal = new AbortController().signal) =>
    controller.execute({ action: "queue", callerThreadId: caller, cwd: "C:/repo", queue: "heavy", ...input }, signal);
  const dequeue = (caller: WorkbenchThreadId, input: Record<string, string> = {}) =>
    controller.execute({ action: "dequeue", callerThreadId: caller, cwd: "C:/repo", queue: "heavy", ...input }, new AbortController().signal);
  return { controller, emit, queue, dequeue, notices, warnings };
}

async function holderAndWaiters() {
  const harness = createHarness();
  await harness.queue(parent);
  assert.match(await harness.queue(ada, { description: "build" }), /You hold queue `heavy`/u);
  const bramWait = track(harness.queue(bram, { description: "tests" }));
  await flush();
  return { ...harness, bramWait };
}

test("children cannot use a queue their parent has not declared", async () => {
  const { queue } = createHarness();
  await assert.rejects(queue(ada, { description: "build" }), /has not been declared by your parent agent/u);
  assert.match(await queue(parent), /Declared queue `heavy`/u);
  assert.match(await queue(ada, { description: "build" }), /You hold queue `heavy`/u);
});

test("dequeue hands the hold to the next waiter in join order", async () => {
  const { dequeue, bramWait } = await holderAndWaiters();
  assert.equal(bramWait.text, null);
  await dequeue(ada);
  await flush();
  assert.match(bramWait.text ?? "", /You hold queue `heavy`/u);
  assert.match(bramWait.text ?? "", /Previous holder: ada \(dequeued\)/u);
});

test("a holder whose turn ends pauses the queue until the parent removes it, and the parent's wait learns why", async () => {
  const { controller, emit, dequeue, bramWait } = await holderAndWaiters();
  emit(ada, turnEnded);
  await flush();
  assert.equal(bramWait.text, null);
  assert.match(controller.takeReleaseNote(ada) ?? "", /ada still holds queue `heavy`.*turn ended.*name: "ada"/u);
  assert.equal(controller.takeReleaseNote(ada), null);
  await assert.rejects(dequeue(bram, { name: "ada" }), /Only the parent agent/u);
  await dequeue(parent, { name: "ada" });
  await flush();
  assert.match(bramWait.text ?? "", /Previous holder: ada \(removed by parent\)/u);
});

test("task completion pauses like a turn end, and a resumed holder keeps its hold", async () => {
  const { emit, dequeue, notices, bramWait } = await holderAndWaiters();
  emit(ada, completed);
  emit(ada, working);
  await flush();
  assert.equal(bramWait.text, null);
  assert.match(notices.find(notice => notice.threadId === ada)?.message ?? "", /still hold queue `heavy`/u);
  await dequeue(ada);
  await flush();
  assert.match(bramWait.text ?? "", /You hold/u);
});

test("stopping the holder hands off immediately", async () => {
  const { emit, bramWait } = await holderAndWaiters();
  emit(ada, stopped);
  await flush();
  assert.match(bramWait.text ?? "", /Previous holder: ada \(stopped\)/u);
});

test("a waiting member loses its place when its turn ends, but not for a pending questionnaire", async () => {
  const { controller, emit, queue, bramWait } = await holderAndWaiters();
  emit(bram, questionnaire);
  await flush();
  assert.equal(bramWait.text, null);
  emit(bram, turnEnded);
  await flush();
  assert.match(bramWait.text ?? "", /You left queue `heavy`/u);
  assert.doesNotMatch(await queue(parent), /bram/u);
  assert.match(controller.takeReleaseNote(bram) ?? "", /bram left queue `heavy`: turn ended while waiting/u);
});

test("an inactive parent freezes promotion until it works again", async () => {
  const { emit, dequeue, queue, bramWait } = await holderAndWaiters();
  emit(parent, turnEnded);
  await dequeue(ada);
  await flush();
  assert.equal(bramWait.text, null);
  assert.match(await queue(parent), /Frozen/u);
  emit(parent, working);
  await flush();
  assert.match(bramWait.text ?? "", /You hold/u);
});

test("placement never preempts the holder, and a holder yields by rejoining behind the next member", async () => {
  const { queue, bramWait } = await holderAndWaiters();
  const cleoWait = track(queue(cleo, { description: "lint", before: "ada" }));
  await flush();
  assert.match(await queue(parent), /1\. \*\*ada\*\*[^\n]*\n2\. \*\*cleo\*\*[^\n]*\n3\. \*\*bram\*\*/u);
  const adaWait = track(queue(ada, { after: "cleo" }));
  await flush();
  assert.match(cleoWait.text ?? "", /Previous holder: ada \(yielded\)/u);
  assert.equal(adaWait.text, null);
  assert.equal(bramWait.text, null);
  assert.match(await queue(parent), /1\. \*\*cleo\*\*[^\n]*\n2\. \*\*ada\*\*[^\n]*\n3\. \*\*bram\*\*/u);
});

test("the parent can reorder waiters", async () => {
  const { queue, dequeue, bramWait } = await holderAndWaiters();
  const cleoWait = track(queue(cleo, { description: "lint" }));
  await flush();
  await queue(parent, { name: "cleo", before: "bram" });
  await dequeue(ada);
  await flush();
  assert.match(cleoWait.text ?? "", /You hold/u);
  assert.equal(bramWait.text, null);
});

test("an interrupted wait keeps its place and is told when it reaches the front", async () => {
  const { queue, dequeue, notices } = createHarness();
  await queue(parent);
  await queue(ada, { description: "build" });
  const abort = new AbortController();
  const interrupted = track(queue(bram, { description: "tests" }, abort.signal));
  await flush();
  abort.abort(new Error("steered"));
  await flush();
  assert.match(String(interrupted.error), /steered/u);
  await dequeue(ada);
  await flush();
  assert.match(notices.find(notice => notice.threadId === bram)?.message ?? "", /reached the front of queue `heavy`/u);
  assert.match(await queue(bram, { description: "tests" }), /You hold/u);
});

test("queues survive a core generation handoff while waits re-enter", async () => {
  const first = await holderAndWaiters();
  const handoff = first.controller.captureReloadState();
  first.controller.dispose();
  await flush();
  assert.ok(isWorkbenchAgentMcpRuntimeReloadInterruption(first.bramWait.error));
  const second = createHarness(handoff);
  const bramWait = track(second.queue(bram, { description: "tests" }));
  await flush();
  assert.equal(bramWait.text, null);
  await second.dequeue(ada);
  await flush();
  assert.match(bramWait.text ?? "", /You hold/u);
});
