/* No production exports. Tests protect isolated identity, generation-scoped drain policy, diagnostics, user stops of shells and stoppable calls, queue skips, shell queue steers, yielded shells, steer races, and reload-stable cancellation. */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchAgentCommandRequest } from "../lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchShellRun } from "../providers/provider-execution";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  isWorkbenchAgentMcpSteerInterruption,
  isWorkbenchAgentMcpCallStop,
  WorkbenchAgentMcpRequestRegistry,
  type WorkbenchAgentMcpUndeliveredMessage,
} from "./workbench-agent-mcp-request-registry";

function registrationOptions(owner: object, toolName = "task_get") {
  return { owner, toolName };
}

test("isolated registry rejects duplicate IDs and aborts active work on disposal", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const registration = registry.register("client-1", "request-1", registrationOptions(owner));
  assert.throws(() => registry.register("client-1", "request-1", registrationOptions(owner)), /already active/u);
  assert.equal(registration.signal.aborted, false);
  registry.dispose();
  assert.equal(registration.signal.aborted, true);
  assert.match(String(registration.signal.reason), /shutting down/u);
  assert.throws(() => registry.register("client-1", "request-2", registrationOptions(owner)), /disposed/u);
  registration.unregister();
});

test("request IDs and cancellation are isolated by client across wrapper generations", () => {
  const requestId = `reload-${process.pid}-${Date.now()}`;
  const owner = {};
  const admitted = getProcessWorkbenchAgentMcpRequestRegistry();
  const first = admitted.register("client-1", requestId, registrationOptions(owner));
  const second = admitted.register("client-2", requestId, registrationOptions(owner));
  const reloaded = getProcessWorkbenchAgentMcpRequestRegistry();
  try {
    assert.equal(reloaded.cancel("client-1", requestId, "new generation cancelled it"), true);
    assert.equal(first.signal.aborted, true);
    assert.match(String(first.signal.reason), /new generation/u);
    assert.equal(second.signal.aborted, false);
    assert.equal(reloaded.cancel("client-1", requestId), false);
  } finally {
    first.unregister();
    second.unregister();
  }
});

test("user shell stops abort only the shell its thread's item names, once, with its elapsed time", () => {
  let now = 1_000;
  const registry = new WorkbenchAgentMcpRequestRegistry(undefined, () => now);
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other-thread");
  const recorded = registry.register("client-1", 1, { owner, toolName: "shell", shellItem: { threadId, references: ["item-1"] } });
  const native = registry.register("client-1", 2, { owner, toolName: "shell", shellItem: { references: ["call_native"] } });
  const unrecorded = registry.register("client-1", 3, { owner, toolName: "shell", shellItem: { references: [] } });
  const ordinary = registry.register("client-1", 4, registrationOptions(owner));
  try {
    now = 66_000;
    assert.equal(registry.stopCall(otherThreadId, ["item-1"]), false, "another thread's view cannot stop this shell");
    assert.equal(registry.stopCall(threadId, ["item-1"]), true);
    assert.ok(isWorkbenchAgentMcpCallStop(recorded.signal.reason));
    assert.equal((recorded.signal.reason as Error).message, "The user stopped this command after 1m 5s.");
    assert.equal(registry.stopCall(threadId, ["item-1"]), false, "an already stopped shell reports nothing left to stop");
    assert.equal(registry.stopCall(threadId, ["public-item", "call_native"]), true, "a shell without thread identity matches its references");
    assert.equal(native.signal.aborted, true);
    assert.equal(unrecorded.signal.aborted, false);
    assert.equal(ordinary.signal.aborted, false);
    assert.equal(isWorkbenchAgentMcpCallStop(new Error("The user stopped this command after 1m 5s.")), false);
  } finally {
    for (const registration of [recorded, native, unrecorded, ordinary]) registration.unregister();
  }
});

test("a stoppable call stops by its transcript item once it names one, and only in its own thread", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry(undefined, () => 5_000);
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const call = registry.register("client-1", 1, { owner, toolName: "mcp_call" });
  try {
    assert.equal(registry.stopCall(threadId, ["call-item"]), false, "a call without stop references is not stoppable");
    call.setWorkbenchThreadId(threadId);
    call.setStopReferences(["call-item", "call_native"]);
    assert.equal(registry.stopCall(WorkbenchThreadIdSchema.parse("other-thread"), ["call-item"]), false);
    assert.equal(registry.stopCall(threadId, ["call_native"]), true);
    assert.ok(isWorkbenchAgentMcpCallStop(call.signal.reason));
    assert.equal((call.signal.reason as Error).message, "The user stopped this call after 0s.");
  } finally {
    call.unregister();
  }
});

test("a shell's queue wait is published by thread, and only a still-queued shell starts now", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other-thread");
  const changed: string[] = [];
  const stop = registry.subscribeShellQueue(changedThreadId => changed.push(changedThreadId));
  const shell = registry.register("client-1", 1, { owner, toolName: "shell", shellItem: { threadId, references: ["item-1", "call_1"] } });
  const ticket = shell.shellQueue!;
  try {
    assert.deepEqual(registry.readShellQueue(threadId), [], "a shell that never waited has no queue entry");
    ticket.queued(100);
    assert.deepEqual(registry.readShellQueue(threadId), [{ admittedAt: null, itemReferences: ["item-1", "call_1"], queuedAt: 100 }]);
    assert.deepEqual(registry.readShellQueue(otherThreadId), []);
    assert.equal(registry.startShellNow(otherThreadId, ["item-1"]), false, "another thread's view cannot skip this shell");
    assert.equal(registry.startShellNow(threadId, ["call_1"]), true);
    assert.equal(ticket.skip?.aborted, true);
    assert.equal(registry.startShellNow(threadId, ["item-1"]), false, "a skip is requested once");
    ticket.admitted(160);
    assert.deepEqual(registry.readShellQueue(threadId), [{ admittedAt: 160, itemReferences: ["item-1", "call_1"], queuedAt: 100 }]);
  } finally {
    shell.unregister();
    stop();
  }
  assert.deepEqual(registry.readShellQueue(threadId), []);
  assert.deepEqual(changed, [threadId, threadId, threadId], "queued, admitted and unregistered each publish");

  const admitted = registry.register("client-1", 2, { owner, toolName: "shell", shellItem: { threadId, references: ["item-2"] } });
  admitted.shellQueue!.queued(200);
  admitted.shellQueue!.admitted(210);
  assert.equal(registry.startShellNow(threadId, ["item-2"]), false, "an admitted shell is no longer queued");
  admitted.unregister();
  assert.equal(registry.register("client-1", 3, registrationOptions(owner)).shellQueue, undefined, "only shells get a queue ticket");
});

test("a running shell's output publishes as one windowed tail per thread, intact across split characters", () => {
  const pending: Array<{ publish: () => void; cancelled: boolean }> = [];
  const registry = new WorkbenchAgentMcpRequestRegistry(undefined, Date.now, publish => {
    const timer = { publish, cancelled: false };
    pending.push(timer);
    return () => { timer.cancelled = true; };
  });
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const published: string[] = [];
  const stop = registry.subscribeShellOutput(changed => published.push(registry.readShellOutput(changed)[0]?.tail ?? "<none>"));
  const shell = registry.register("client-1", 1, { owner, toolName: "shell", shellItem: { threadId, references: ["item-1"] } });
  const output = shell.shellQueue!.output!;
  const heart = Buffer.from("♡", "utf8");
  try {
    output("stdout", Buffer.from("Selected 3 tests\n"));
    output("stdout", heart.subarray(0, 1));
    output("stdout", Buffer.concat([heart.subarray(1), Buffer.from("\n")]));
    output("stderr", Buffer.from("warn\n"));
    assert.equal(pending.length, 1, "a burst arms one publication for the thread");
    assert.equal(published.length, 0);
    pending[0]!.publish();
    assert.deepEqual(published, ["Selected 3 tests\n♡\nwarn\n"]);
    output("stdout", Buffer.from("x".repeat(20_000)));
    pending[1]!.publish();
    assert.equal(published.at(-1)!.length, 16_384, "the tail keeps only the newest output");
    output("stdout", Buffer.from("last line\n"));
  } finally {
    shell.unregister();
    stop();
  }
  assert.equal(pending[2]!.cancelled, true, "a finished shell publishes now instead of one window later");
  assert.equal(published.at(-1), "<none>", "and its tail leaves with it");
  assert.equal(published.length, 3);
});

test("steers interrupt a shell only while it waits in the expensive queue", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const waits: string[][] = [];
  const stop = registry.subscribeThreadWaits(state => waits.push(state.toolNames));
  const queued = registry.register("client-1", 1, { owner, toolName: "shell", shellItem: { threadId, references: ["queued"] } });
  const running = registry.register("client-1", 2, { owner, toolName: "shell", shellItem: { threadId, references: ["running"] } });
  running.shellQueue!.queued(0);
  running.shellQueue!.admitted(5);
  assert.equal(registry.interruptThreadWaits(threadId), 0, "an unqueued or admitted shell is real work, never a wait");
  queued.shellQueue!.queued(10);
  assert.deepEqual(waits.at(-1), ["shell"], "a queued shell shows as a thread wait");
  assert.equal(registry.interruptThreadWaits(threadId), 0, "the agent reads a steer only after its running shell, so the queue is held");
  assert.equal(queued.signal.aborted, false);
  running.unregister();
  assert.equal(isWorkbenchAgentMcpSteerInterruption(queued.signal.reason), true, "the held steer lands once nothing else runs");
  assert.equal(running.signal.aborted, false);
  queued.unregister();
  assert.deepEqual(waits.at(-1), []);

  const alone = registry.register("client-1", 4, { owner, toolName: "shell", shellItem: { threadId, references: ["alone"] } });
  alone.shellQueue!.queued(12);
  assert.equal(registry.interruptThreadWaits(threadId), 1, "with nothing running, a steer interrupts at once");
  alone.unregister();

  const sibling = registry.register("client-1", 5, { owner, toolName: "shell", shellItem: { threadId, references: ["sibling"] } });
  const held = registry.register("client-1", 6, { owner, toolName: "shell", shellItem: { threadId, references: ["held"] } });
  held.shellQueue!.queued(14);
  registry.declareToolBatch(threadId, "message", ["sibling", "held"]);
  registry.interruptThreadWaits(threadId);
  registry.endToolBatch(threadId);
  sibling.unregister();
  assert.equal(held.signal.aborted, false, "a held steer ends with its batch, where the agent reads it");
  held.unregister();

  const late = registry.register("client-1", 3, { owner, toolName: "shell", shellItem: { references: ["late"] } });
  late.shellQueue!.queued(20);
  assert.equal(registry.interruptThreadWaits(threadId), 0, "a steer waits for the shell's thread identity");
  late.shellQueue!.admitted(30);
  late.setWorkbenchThreadId(threadId);
  assert.equal(late.signal.aborted, false, "a deferred steer never reaches a shell admitted since");
  late.unregister();
  stop();
});

test("a yield_ms shell queued for an expensive slot is a thread wait, as is a call held behind it", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const signal = new AbortController().signal;
  const waits: string[][] = [];
  const stop = registry.subscribeThreadWaits(state => { if (state.threadId === threadId) waits.push(state.toolNames); });
  try {
    registry.declareToolBatch(threadId, "message", ["yielding", "after"]);
    const yielding = registry.register("client-1", 1, {
      owner, toolName: "shell", yields: true, toolUseKey: "yielding", shellItem: { threadId, references: ["yielding"] },
    });
    yielding.shellQueue!.queued(0);
    assert.deepEqual(waits.at(-1), ["shell"], "its yield clock has not started, so the agent only waits");
    const behind = track(registry.awaitBatchTurn("after", signal, "message_user"));
    await settle();
    assert.deepEqual(waits.at(-1), ["message_user", "shell"], "a call held behind the queued shell waits too");
    yielding.shellQueue!.admitted(5);
    assert.deepEqual(waits.at(-1), [], "once admitted the agent works on past it");
    registry.settleToolUse("yielding", false);
    await settle();
    assert.equal(behind.value, "ready");
    yielding.unregister();
  } finally {
    registry.endToolBatch(threadId);
    stop();
  }
});

test("a batch call behind a yield_ms shell never shows its thread as waiting; behind a plain shell it does", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const signal = new AbortController().signal;
  const waits: string[][] = [];
  const stop = registry.subscribeThreadWaits(state => { if (state.threadId === threadId) waits.push(state.toolNames); });
  try {
    registry.declareToolBatch(threadId, "message-1", ["yielding", "after-yield"]);
    const behindYield = track(registry.awaitBatchTurn("after-yield", signal));
    await settle();
    const yielding = registry.register("client-1", 1, {
      owner, toolName: "shell", yields: true, toolUseKey: "yielding", shellItem: { threadId, references: ["yielding"] },
    });
    assert.deepEqual(waits.at(-1), [], "the agent means to work on past its yield_ms shell");
    const replayed: string[][] = [];
    registry.subscribeThreadWaits(state => replayed.push(state.toolNames))();
    assert.deepEqual(replayed, [], "a new subscriber sees no wait either");
    registry.settleToolUse("yielding", false);
    await settle();
    assert.equal(behindYield.value, "ready");
    yielding.unregister();

    registry.declareToolBatch(threadId, "message-2", ["plain", "after-plain"]);
    const plain = registry.register("client-1", 2, {
      owner, toolName: "shell", toolUseKey: "plain", shellItem: { threadId, references: ["plain"] },
    });
    const behindPlain = track(registry.awaitBatchTurn("after-plain", signal));
    await settle();
    assert.deepEqual(waits.at(-1), ["shell"], "a call behind a plain shell still waits");
    registry.endToolBatch(threadId);
    await settle();
    assert.equal(behindPlain.value, "ready");
    plain.unregister();
  } finally {
    registry.endToolBatch(threadId);
    stop();
  }
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function track<T>(promise: Promise<T>) {
  const state: { value?: T } = {};
  void promise.then(value => { state.value = value; });
  return state;
}

test("a yielded shell frees its call, never delays a steer, and stays stoppable from its row", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const yielded = registry.register("client-1", 1, {
    owner, toolName: "shell", shellItem: { threadId, references: ["item-1"], command: "pnpm build" },
  });
  yielded.shellQueue!.output!("stdout", Buffer.from("building..."));
  const changed: string[] = [];
  const stopListening = registry.subscribeShellOutput(thread => { changed.push(thread); });
  assert.deepEqual(registry.readYieldedShells(threadId), [], "a shell whose call still waits has not yielded");
  assert.throws(() => registry.backgroundShell("client-1", 99), /running shell call/u);
  const shellId = registry.backgroundShell("client-1", 1);
  stopListening();
  assert.equal(shellId, "item-1", "a yielded shell is named after its transcript row, so its waits can find it");
  assert.deepEqual(registry.readYieldedShells(threadId), [{ reference: "item-1", command: "pnpm build" }]);
  assert.equal(registry.readBackgroundShellCommand(shellId), "pnpm build", "its waits can name it without its row");
  assert.ok(changed.includes(threadId), "rows learn of the yield as it happens");
  assert.equal(registry.readBackgroundShellTail(shellId), "building...");
  const reused = registry.register("client-1", 1, registrationOptions(owner));
  reused.unregister();
  yielded.unregister();
  assert.equal(yielded.signal.aborted, false, "its call ending leaves the command running");

  const queued = registry.register("client-1", 2, { owner, toolName: "shell", shellItem: { threadId, references: ["queued"] } });
  queued.shellQueue!.queued(0);
  assert.equal(registry.interruptThreadWaits(threadId), 1, "a yielded shell is no running call that holds a steer back");
  queued.unregister();

  assert.equal(registry.stopCall(threadId, ["item-1"]), true);
  assert.ok(isWorkbenchAgentMcpCallStop(yielded.signal.reason));
  registry.finishBackgroundShell(shellId, { content: [] });
  assert.deepEqual(registry.readYieldedShells(threadId), [], "a finished shell's row carries the yield from here");
});

test("a yielded shell that already finished still names its command until it is collected", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  registry.register("client-1", 1, { owner: {}, toolName: "shell", shellItem: { threadId, references: ["item-1"], command: "pnpm build" } });
  const shellId = registry.backgroundShell("client-1", 1);
  registry.finishBackgroundShell(shellId, { content: [] });
  assert.equal(registry.readBackgroundShellCommand(shellId), "pnpm build");
  await registry.awaitBackgroundShell(shellId, threadId, new AbortController().signal);
  assert.equal(registry.readBackgroundShellCommand(shellId), null);
});

test("a steer ends a yielding shell's window without stopping its command, unless it still waits in the queue", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const shell = (requestId: number) => registry.register("client-1", requestId, {
    owner, toolName: "shell", yields: true, shellItem: { threadId, references: [`item-${requestId}`] },
  });

  const running = shell(1);
  assert.equal(registry.interruptThreadWaits(threadId), 1);
  assert.equal(running.earlyYield?.aborted, true, "the call may answer now");
  assert.equal(running.signal.aborted, false, "the command runs on");
  registry.backgroundShell("client-1", 1);

  const queued = shell(2);
  queued.shellQueue!.queued(0);
  assert.equal(registry.interruptThreadWaits(threadId), 1);
  assert.ok(isWorkbenchAgentMcpSteerInterruption(queued.signal.reason), "a command that never started is cancelled, not backgrounded");
  queued.unregister();

  const plain = registry.register("client-1", 3, { owner, toolName: "shell", shellItem: { threadId, references: ["item-3"] } });
  assert.equal(plain.earlyYield, undefined);
  assert.equal(registry.interruptThreadWaits(threadId), 0, "a backgrounded or plain shell takes no steer");
  assert.equal(running.signal.aborted, false);
  assert.equal(plain.signal.aborted, false);
  plain.unregister();
  registry.stopBackgroundShells(threadId);
});

test("a yielding shell starting while a steer is undelivered yields at once", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  registry.activateUndeliveredMessages(owner, async () => [{}]);
  const shell = registry.register("client-1", 1, { owner, toolName: "shell", yields: true, shellItem: { threadId, references: ["item-1"] } });
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(shell.earlyYield?.aborted, true);
  assert.equal(shell.signal.aborted, false);
  shell.unregister();
});

test("a yielded shell's result goes once to its own thread, and its turn ending stops and discards it", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other-thread");
  const result = { content: [{ type: "text" as const, text: "Exit code: 0" }] };
  const start = (requestId: number) => {
    const registration = registry.register("client-1", requestId, { owner, toolName: "shell", shellItem: { threadId, references: [`item-${requestId}`] } });
    return { registration, shellId: registry.backgroundShell("client-1", requestId) };
  };
  const signal = new AbortController().signal;

  const finished = start(1);
  const waiting = track(registry.awaitBackgroundShell(finished.shellId, threadId, signal));
  await settle();
  assert.equal(waiting.value, undefined, "a running shell is waited for");
  await assert.rejects(registry.awaitBackgroundShell(finished.shellId, otherThreadId, signal), /No yielded shell/u);
  registry.finishBackgroundShell(finished.shellId, result);
  await settle();
  assert.deepEqual(waiting.value, result);
  await assert.rejects(registry.awaitBackgroundShell(finished.shellId, threadId, signal), /already collected/u);

  const running = start(2);
  const uncollected = start(3);
  registry.finishBackgroundShell(uncollected.shellId, result);
  assert.equal(registry.stopBackgroundShells(threadId), 1);
  assert.ok(isWorkbenchAgentMcpCallStop(running.registration.signal.reason));
  assert.match((running.registration.signal.reason as Error).message, /turn ended/u);
  registry.finishBackgroundShell(running.shellId, result);
  await assert.rejects(registry.awaitBackgroundShell(running.shellId, threadId, signal), /No yielded shell/u);
  await assert.rejects(registry.awaitBackgroundShell(uncollected.shellId, threadId, signal), /No yielded shell/u);
});

test("a serial call waits for every earlier call of its batch to report, then runs or is skipped after a failure", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const signal = new AbortController().signal;
  const early = track(registry.awaitBatchTurn("build", signal));
  await settle();
  assert.equal(early.value, undefined, "a call whose batch is not declared yet waits for it");
  registry.declareToolBatch(threadId, "message-1", ["read", "build"]);
  registry.declareToolBatch(threadId, "message-1", ["edit", "test"]);
  await settle();
  assert.equal(early.value, undefined, "an earlier native read must report first");
  registry.settleToolUse("read", false);
  await settle();
  assert.equal(early.value, "ready");
  const test = track(registry.awaitBatchTurn("test", signal));
  registry.settleToolUse("build", false);
  await settle();
  assert.equal(test.value, undefined, "a later part of the same message extends its batch");
  registry.settleToolUse("edit", true);
  await settle();
  assert.equal(test.value, "skipped", "a failure reported late still skips the call waiting behind it");
});

test("a batch an older generation stored in another shape never breaks a lookup, and a declaration replaces it", async () => {
  const registry = getProcessWorkbenchAgentMcpRequestRegistry();
  const state = Reflect.get(globalThis, Symbol.for("workbench.agentMcpRequestRegistry.v2")) as { toolBatches: Map<string, unknown> };
  const staleThreadId = WorkbenchThreadIdSchema.parse(`stale-${process.pid}`);
  const threadId = WorkbenchThreadIdSchema.parse(`current-${process.pid}`);
  state.toolBatches.set(staleThreadId, { id: "old", entries: [{ key: "old-call", shell: true, parallel: false }] });
  try {
    const signal = new AbortController().signal;
    registry.settleToolUse("old-call", true);
    assert.equal(await registry.awaitBatchTurn("old-call", signal, "Edit", 0), "ready", "an unreadable batch holds nothing");
    registry.declareToolBatch(threadId, "message", ["a", "b"]);
    registry.settleToolUse("a", true);
    assert.equal(await registry.awaitBatchTurn("b", signal, "Edit", 0), "skipped", "other threads' stale batches never hide this one");
    registry.declareToolBatch(staleThreadId, "new", ["c"]);
    assert.equal(await registry.awaitBatchTurn("c", signal, "Edit", 0), "ready");
  } finally {
    registry.endToolBatch(staleThreadId);
    registry.endToolBatch(threadId);
  }
});

test("a batch's end, its replacement, a steer or the caller release a waiting call, and another thread never holds it", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other-thread");
  const signal = new AbortController().signal;
  const waits: string[][] = [];
  const stop = registry.subscribeThreadWaits(state => { if (state.threadId === threadId) waits.push(state.toolNames); });
  registry.declareToolBatch(otherThreadId, "other", ["other-build", "other-test"]);
  registry.declareToolBatch(threadId, "message-1", ["a", "b"]);
  const ended = track(registry.awaitBatchTurn("b", signal));
  await settle();
  assert.deepEqual(waits.at(-1), ["shell"], "a waiting shell is a thread wait");
  assert.equal(registry.interruptThreadWaits(otherThreadId), 0, "another thread's steer reaches nothing here");
  registry.endToolBatch(threadId);
  await settle();
  assert.equal(ended.value, "ready");
  assert.deepEqual(waits.at(-1), []);

  registry.declareToolBatch(threadId, "message-2", ["c", "d"]);
  const replaced = track(registry.awaitBatchTurn("d", signal));
  await settle();
  registry.declareToolBatch(threadId, "message-3", ["e"]);
  await settle();
  assert.equal(replaced.value, "ready");

  registry.declareToolBatch(threadId, "message-4", ["f", "g"]);
  const steered = track(registry.awaitBatchTurn("g", signal));
  await settle();
  assert.equal(registry.interruptThreadWaits(threadId, "agent message", ["message_wait"]), 1);
  await settle();
  assert.equal(steered.value, "interrupted");

  const caller = new AbortController();
  const cancelled = registry.awaitBatchTurn("other-test", caller.signal);
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(cancelled, /caller cancelled/u);
  stop();
});

test("thread steers interrupt only declared waits for the matching thread across clients and owners", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const firstOwner = {};
  const secondOwner = {};
  const parentThreadId = WorkbenchThreadIdSchema.parse("parent-thread");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other-thread");
  const subagentWait = registry.register("client-1", 1, {
    owner: firstOwner,
    steerInterruptible: true,
    toolName: "subagent_wait",
  });
  subagentWait.setWorkbenchThreadId(parentThreadId);
  const secondWait = registry.register("client-2", 1, {
    owner: secondOwner,
    steerInterruptible: true,
    toolName: "subagent_wait",
  });
  secondWait.setWorkbenchThreadId(parentThreadId);
  const otherThreadWait = registry.register("client-1", 2, {
    owner: firstOwner,
    steerInterruptible: true,
    toolName: "subagent_wait",
  });
  otherThreadWait.setWorkbenchThreadId(otherThreadId);
  const ordinaryCall = registry.register("client-2", 2, {
    owner: secondOwner,
    toolName: "task_get",
  });

  assert.equal(registry.interruptThreadWaits(parentThreadId), 2);
  assert.equal(subagentWait.signal.aborted, true);
  assert.equal(isWorkbenchAgentMcpSteerInterruption(subagentWait.signal.reason), true);
  assert.equal(secondWait.signal.aborted, true);
  assert.equal(otherThreadWait.signal.aborted, false);
  assert.equal(ordinaryCall.signal.aborted, false);
  assert.equal(registry.interruptThreadWaits(parentThreadId), 0);
  assert.throws(() => subagentWait.setWorkbenchThreadId(otherThreadId), /cannot change/u);

  subagentWait.unregister();
  secondWait.unregister();
  otherThreadWait.unregister();
  ordinaryCall.unregister();
});

test("thread wait observation derives every active interruptible tool from live registrations", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("parent-thread");
  const states: Array<{ identityKind: "workbench"; threadId: typeof threadId; toolNames: string[] }> = [];
  const stop = registry.subscribeThreadWaits((state) => states.push(state));
  const owner = {};
  const subagent = registry.register("client-1", 1, {
    owner, steerInterruptible: true, toolName: "subagent_wait",
  });
  subagent.setWorkbenchThreadId(threadId);
  const arc = registry.register("client-2", 1, {
    owner, steerInterruptible: true, toolName: "git_arc_wait",
  });
  arc.setWorkbenchThreadId(threadId);
  const ordinary = registry.register("client-1", 2, {
    owner, toolName: "task_get",
  });
  ordinary.setWorkbenchThreadId(threadId);
  const replayed: typeof states = [];
  const stopReplay = registry.subscribeThreadWaits((state) => replayed.push(state));
  assert.deepEqual(replayed, [{
    identityKind: "workbench",
    threadId,
    toolNames: ["git_arc_wait", "subagent_wait"],
  }]);
  stopReplay();
  arc.unregister();
  subagent.unregister();
  ordinary.unregister();
  stop();
  assert.deepEqual(states, [
    { identityKind: "workbench", threadId, toolNames: ["subagent_wait"] },
    { identityKind: "workbench", threadId, toolNames: ["git_arc_wait", "subagent_wait"] },
    { identityKind: "workbench", threadId, toolNames: ["subagent_wait"] },
    { identityKind: "workbench", threadId, toolNames: [] },
  ]);
});

test("agent-message interruption excludes message waits but user steers still interrupt them", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("caller");
  const messageWait = registry.register("client", "message", { owner: {}, toolName: "message_wait", steerInterruptible: true });
  const subagentWait = registry.register("client", "subagent", { owner: {}, toolName: "subagent_wait", steerInterruptible: true });
  messageWait.setWorkbenchThreadId(threadId);
  subagentWait.setWorkbenchThreadId(threadId);
  assert.equal(registry.interruptThreadWaits(threadId, "agent message", ["message_wait"]), 1);
  assert.equal(messageWait.signal.aborted, false);
  assert.equal(subagentWait.signal.aborted, true);
  assert.equal(registry.interruptThreadWaits(threadId), 1);
  assert.equal(isWorkbenchAgentMcpSteerInterruption(messageWait.signal.reason), true);
  messageWait.unregister();
  subagentWait.unregister();
  registry.dispose();
});

test("steers admitted while wait identity resolves interrupt only matching eligible requests", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("caller");
  const otherThreadId = WorkbenchThreadIdSchema.parse("other");
  assert.equal(registry.interruptThreadWaits(threadId), 0, "an earlier steer cannot poison a future wait");
  const matching = registry.register("client", "matching", {
    owner, toolName: "subagent_wait", steerInterruptible: true,
  });
  const other = registry.register("client", "other", {
    owner, toolName: "subagent_wait", steerInterruptible: true,
  });
  const excluded = registry.register("client", "excluded", {
    owner, toolName: "message_wait", steerInterruptible: true,
  });

  assert.equal(registry.interruptThreadWaits(threadId, "agent message", ["message_wait"]), 0);
  matching.setWorkbenchThreadId(threadId);
  other.setWorkbenchThreadId(otherThreadId);
  excluded.setWorkbenchThreadId(threadId);
  assert.equal(matching.signal.aborted, true);
  assert.equal(isWorkbenchAgentMcpSteerInterruption(matching.signal.reason), true);
  assert.equal(other.signal.aborted, false);
  assert.equal(excluded.signal.aborted, false);

  const future = registry.register("client", "future", {
    owner, toolName: "subagent_wait", steerInterruptible: true,
  });
  future.setWorkbenchThreadId(threadId);
  assert.equal(future.signal.aborted, false, "a request registered after an earlier steer stays live");
  for (const registration of [matching, other, excluded, future]) registration.unregister();
  registry.dispose();
});

test("command executor replacement retries one built request without surfacing reload", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const oldOwner = {};
  const newOwner = {};
  const request = {
    body: { callerThreadId: "thread-1" },
    method: "POST",
    path: "/api/subagents",
    responseKind: "native",
  } satisfies WorkbenchAgentCommandRequest;
  let oldSignal = null as AbortSignal | null;
  registry.activateCommandExecutor(oldOwner, async (_request, signal) => {
    oldSignal = signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const waiting = registry.executeCommand(request, new AbortController().signal);
  await Promise.resolve();
  registry.activateCommandExecutor(newOwner, async (retried) => {
    assert.strictEqual(retried, request);
    return new Response("completed after reload");
  });
  assert.equal(oldSignal?.aborted, true);
  assert.equal(await (await waiting).text(), "completed after reload");
  registry.releaseCommandExecutor(oldOwner);
  registry.releaseCommandExecutor(newOwner);
});

test("successful retiring command wins and executor shutdown stays terminal", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const oldOwner = {};
  const newOwner = {};
  const request = {
    method: "POST",
    path: "/api/git-checkpoint",
    responseKind: "git-arc-wait",
  } satisfies WorkbenchAgentCommandRequest;
  let finishOld!: () => void;
  registry.activateCommandExecutor(oldOwner, async () => {
    await new Promise<void>((resolve) => { finishOld = resolve; });
    return new Response("retiring success");
  });
  const waiting = registry.executeCommand(request, new AbortController().signal);
  await Promise.resolve();
  let replacementCalls = 0;
  registry.activateCommandExecutor(newOwner, async () => {
    replacementCalls += 1;
    return new Response("replacement");
  });
  finishOld();
  assert.equal(await (await waiting).text(), "retiring success");
  assert.equal(replacementCalls, 0);
  registry.releaseCommandExecutor(oldOwner);
  registry.releaseCommandExecutor(newOwner);

  const shutdownOwner = {};
  registry.activateCommandExecutor(shutdownOwner, async (_request, signal) => (
    await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  ));
  const shuttingDown = registry.executeCommand(request, new AbortController().signal);
  await Promise.resolve();
  registry.releaseCommandExecutor(shutdownOwner);
  await assert.rejects(shuttingDown, /shutting down/u);
});

test("prepared shells wait through an exec reload gap for the current runner, and only their caller cancels", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const run: WorkbenchShellRun = { kind: "approved", label: "build", expensive: false, request: {
    caller: { harness: "claude", threadId: WorkbenchThreadIdSchema.parse("thread-1"), cwd: "C:/work" },
    command: ["build"], cwd: "C:/work", permissions: { mode: "approved-unrestricted" },
  } };
  const retired = {};
  registry.activateShellRunner(retired, async () => { throw new Error("retired runner must not run"); });
  registry.releaseShellRunner(retired);
  const waiting = registry.executeShell(run, new AbortController().signal);
  const current = {};
  registry.activateShellRunner(current, async received => {
    assert.strictEqual(received, run);
    return { exitCode: 0, stdout: "built", stderr: "" };
  });
  assert.deepEqual(await waiting, { exitCode: 0, stdout: "built", stderr: "" });
  registry.releaseShellRunner(current);
  const cancelled = new AbortController();
  const unserved = registry.executeShell(run, cancelled.signal);
  cancelled.abort(new Error("caller cancelled"));
  await assert.rejects(unserved, /caller cancelled/u);
});

test("runtime drain cancels only matching policies in the retiring generation", () => {
  let now = 100;
  const registry = new WorkbenchAgentMcpRequestRegistry(undefined, () => now);
  const retiringOwner = {};
  const currentOwner = {};
  const immediate = registry.register("old-client", 1, {
    owner: retiringOwner,
    policy: "abort-immediately",
    toolName: "subagent_wait",
  });
  const deadline = registry.register("old-client", 2, {
    owner: retiringOwner,
    policy: "abort-at-deadline",
    toolName: "example_bounded_wait",
  });
  const current = registry.register("new-client", 1, {
    owner: currentOwner,
    policy: "abort-immediately",
    toolName: "subagent_wait",
  });

  now = 150;
  assert.equal(registry.beginRuntimeDrain(retiringOwner, "immediate", "generation swapped"), 1);
  assert.equal(immediate.signal.aborted, true);
  assert.equal(deadline.signal.aborted, false);
  assert.equal(current.signal.aborted, false);
  assert.deepEqual(registry.listRuntimeDrainPending(retiringOwner), [
    { ageMs: 50, policy: "abort-at-deadline", toolName: "example_bounded_wait" },
    { ageMs: 50, policy: "abort-immediately", toolName: "subagent_wait" },
  ]);

  assert.equal(registry.beginRuntimeDrain(retiringOwner, "deadline", "deadline expired"), 1);
  assert.equal(deadline.signal.aborted, true);
  const late = registry.register("old-client", 3, {
    owner: retiringOwner,
    policy: "abort-immediately",
    toolName: "subagent_wait",
  });
  assert.equal(late.signal.aborted, true);

  immediate.unregister();
  deadline.unregister();
  current.unregister();
  late.unregister();
});

test("drain-independent requests stay client-cancellable but leave blocker diagnostics", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const registration = registry.register("client-1", 1, {
    owner,
    toolName: "subagent_wait",
  });
  registration.markDrainIndependent();
  assert.deepEqual(registry.listRuntimeDrainPending(owner), []);
  assert.equal(registry.cancel("client-1", 1), true);
  registration.unregister();
});

test("a wait attaching while its thread holds an undelivered message is interrupted as if it just arrived", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  const threadId = WorkbenchThreadIdSchema.parse("caller");
  let undelivered: WorkbenchAgentMcpUndeliveredMessage[] = [];
  registry.activateUndeliveredMessages(owner, async () => undelivered);
  const attach = async (requestId: string, toolName: string) => {
    const wait = registry.register("client", requestId, { owner, toolName, steerInterruptible: true });
    wait.setWorkbenchThreadId(threadId);
    await settle();
    return wait;
  };
  try {
    const quiet = await attach("quiet", "subagent_wait");
    assert.equal(quiet.signal.aborted, false, "a delivered or absent message never poisons a future wait");
    quiet.unregister();

    undelivered = [{ senderThreadId: WorkbenchThreadIdSchema.parse("sibling") }];
    const messageWait = await attach("message", "message_wait");
    const subagentWait = await attach("subagent", "subagent_wait");
    assert.equal(messageWait.signal.aborted, false, "message waits answer agent mail themselves");
    assert.equal(isWorkbenchAgentMcpSteerInterruption(subagentWait.signal.reason), true);
    messageWait.unregister();
    subagentWait.unregister();

    undelivered = [{}];
    const steered = await attach("steered", "message_wait");
    assert.equal(isWorkbenchAgentMcpSteerInterruption(steered.signal.reason), true, "a user steer interrupts every long wait");
    steered.unregister();

    const shell = registry.register("client", "shell", { owner, toolName: "shell", shellItem: { threadId, references: ["queued"] } });
    shell.shellQueue!.queued(0);
    await settle();
    assert.equal(isWorkbenchAgentMcpSteerInterruption(shell.signal.reason), true, "the expensive queue is a long wait too");
    shell.unregister();
  } finally {
    registry.releaseUndeliveredMessages(owner);
    registry.dispose();
  }
});

test("released runtime owners reject late request admission", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  registry.releaseRuntimeOwner(owner);
  assert.throws(() => registry.register("client-1", 1, registrationOptions(owner)), /runtime owner is disposed/u);
});
