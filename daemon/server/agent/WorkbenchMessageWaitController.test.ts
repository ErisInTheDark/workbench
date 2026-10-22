/*
 * Exports: none. Protect message routing, pending sender dependencies, undelivered mail, cancellation, and reload-safe waits.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchMessageWaitController from "./WorkbenchMessageWaitController";
import { createWorkbenchAgentMcpRuntimeReloadInterruption } from "../lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchAgentCommandRequest } from "../lib/workbench/commands/workbench-agent-command-definition";
import { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

const id = WorkbenchThreadIdSchema.parse;
const input = (waitId: string, caller = "caller", senders = ["first", "second"]) => ({
  waitId, callerThreadId: id(caller), senderThreadIds: senders.map(sender => id(sender)),
});
const message = (senderThreadId: string, text = "reply") => ({ senderThreadId, senderName: "luna", message: text });
const received = (senderThreadId: string, text = "reply") => ({ kind: "message", message: message(senderThreadId, text) });

test("pending sender dependencies notify observers and disappear on reply or cancellation", async () => {
  const owner = new WorkbenchMessageWaitController();
  const caller = new AbortController();
  const observed: boolean[] = [];
  const unsubscribe = owner.subscribePending(() => observed.push(owner.isWaitingFor(id("child"), id("parent"))));
  try {
    const waited = owner.wait(input("dependency", "child", ["parent", "sibling"]), caller.signal);
    assert.deepEqual(observed, [true]);
    assert.equal(owner.isWaitingFor(id("other-child"), id("parent")), false);
    assert.equal(owner.isWaitingFor(id("child"), id("other-parent")), false);
    owner.receive("child", message("parent"));
    assert.equal(owner.isWaitingFor(id("child"), id("parent")), false);
    await waited;
    const cancelled = owner.wait(input("cancelled-dependency", "child", ["parent"]), caller.signal);
    caller.abort();
    assert.equal(owner.isWaitingFor(id("child"), id("parent")), false);
    await assert.rejects(cancelled);
    owner.receive("child", message("parent"));
    await owner.wait(input("ready-mail", "child", ["parent"]), new AbortController().signal);
    assert.deepEqual(observed, [true, true]);
  } finally {
    unsubscribe();
    caller.abort();
    owner.dispose();
  }
});

test("dependency reads survive detached reloads but exclude interrupted waits", async () => {
  const owner = new WorkbenchMessageWaitController();
  const caller = new AbortController();
  const generation = new AbortController();
  const waited = owner.wait(input("dependency-reload", "child", ["parent"]), generation.signal, caller.signal);
  generation.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
  await assert.rejects(waited);
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  owner.dispose();
  try {
    assert.equal(successor.isWaitingFor(id("child"), id("parent")), true);
    successor.receive("child", message("sibling"));
    assert.equal(successor.isWaitingFor(id("child"), id("parent")), false);
    assert.deepEqual(await successor.wait(input("dependency-reload", "child", []), new AbortController().signal, caller.signal),
      { kind: "interrupted" });
  } finally {
    caller.abort();
    successor.dispose();
  }
});

test("message waits ignore delivered earlier messages and other recipients, and retain the first matching reply", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  owner.receive("caller", message("first", "before arming"));
  owner.delivered("caller", message("first", "  before arming "));
  const waited = owner.wait(input("wait"), signal);
  owner.receive("other-caller", message("first", "wrong recipient"));
  owner.receive("caller", message("second", "first matching reply"));
  owner.receive("caller", message("first", "later matching reply"));
  assert.deepEqual(await waited, received("second", "first matching reply"));
  owner.dispose();
});

test("a selected sender's undelivered message admitted before the wait attaches is returned once", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  owner.receive("caller", message("second", "sent while the caller was still reasoning"));
  const waited = owner.wait(input("early"), signal);
  owner.receive("caller", message("first", "later reply"));
  assert.deepEqual(await waited, received("second", "sent while the caller was still reasoning"));
  // The later reply arrived with no wait attached, so the next wait picks it up instead of the consumed one.
  assert.deepEqual(await owner.wait(input("next"), signal), received("first", "later reply"));
  owner.dispose();
});

test("another sender's message interrupts a live wait and stays undelivered mail", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  const waited = owner.wait(input("narrow", "caller", ["first"]), signal);
  owner.receive("caller", message("unselected", "unrelated news"));
  owner.receive("caller", message("first", "selected reply"));
  assert.deepEqual(await waited, { kind: "interrupted" });
  assert.deepEqual(await owner.wait(input("broad", "caller", ["unselected"]), signal), received("unselected", "unrelated news"));
  owner.dispose();
});

test("another sender's undelivered mail interrupts a new wait, unless a selected sender's mail is ready", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  owner.receive("caller", message("unselected", "already pending"));
  const waited = owner.wait(input("narrow", "caller", ["first"]), signal);
  owner.receive("caller", message("first", "selected reply"));
  assert.deepEqual(await waited, { kind: "interrupted" }, "the caller has not seen the earlier mail, so it must not sit waiting");
  assert.deepEqual(await owner.wait(input("again", "caller", ["first"]), signal), received("first", "selected reply"));
  assert.deepEqual(owner.undeliveredSenders("caller"), ["unselected"]);
  owner.dispose();
});

test("simultaneous waits observe messages independently without consuming delivery", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  const first = owner.wait(input("one", "caller", ["first"]), signal);
  const overlapping = owner.wait(input("three", "caller", ["first", "second"]), signal);
  owner.receive("caller", message("first"));
  assert.deepEqual(await first, received("first"));
  assert.deepEqual(await overlapping, received("first"));
  const second = owner.wait(input("two", "caller", ["second"]), signal);
  owner.receive("caller", message("second"));
  assert.deepEqual(await second, received("second"));
  owner.dispose();
});

test("cancelled callers detach their wait, including cancellation before registration", async () => {
  const owner = new WorkbenchMessageWaitController();
  const caller = new AbortController();
  const waited = owner.wait(input("cancelled"), caller.signal);
  const reason = new Error("caller disconnected");
  caller.abort(reason);
  await assert.rejects(waited, error => error === reason);
  assert.equal(owner.hasWait("cancelled"), false);
  await assert.rejects(owner.wait(input("never-armed"), caller.signal), error => error === reason);
  assert.equal(owner.hasWait("never-armed"), false);
  owner.dispose();
});

test("reload re-entry retains original senders and a reply admitted between attachments", async () => {
  const owner = new WorkbenchMessageWaitController();
  const caller = new AbortController();
  const generation = new AbortController();
  const waited = owner.wait(input("reload"), generation.signal, caller.signal);
  const handoff = owner.captureReloadState();
  generation.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
  await assert.rejects(waited);
  const successor = new WorkbenchMessageWaitController(handoff);
  owner.dispose();
  successor.receive("caller", message("second", "during reload"));
  assert.deepEqual(await successor.wait(input("reload", "caller", ["changed-name-target"]),
    new AbortController().signal, caller.signal), received("second", "during reload"));
  assert.equal(successor.hasWait("reload"), false);
  caller.abort();
  successor.dispose();
});

test("undelivered mail survives a reload handoff", async () => {
  const owner = new WorkbenchMessageWaitController();
  owner.receive("caller", message("first", "before reload"));
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  owner.dispose();
  const waited = successor.wait(input("after-reload"), new AbortController().signal);
  successor.receive("caller", message("second", "after reload"));
  assert.deepEqual(await waited, received("first", "before reload"));
  successor.dispose();
});

test("terminal cancellation removes retained data while no generation is attached", async () => {
  const owner = new WorkbenchMessageWaitController();
  const caller = new AbortController();
  const generation = new AbortController();
  const waited = owner.wait(input("reload-cancelled"), generation.signal, caller.signal);
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  generation.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
  await assert.rejects(waited);
  caller.abort(new Error("user steer"));
  assert.equal(successor.hasWait("reload-cancelled"), false);
  assert.equal(successor.isWaitingFor(id("caller"), id("first")), false);
  owner.dispose();
  successor.dispose();
});

test("reloads share one invocation cleanup and completion releases it", async () => {
  const caller = new AbortController();
  let owner = new WorkbenchMessageWaitController();
  try {
    for (let generation = 0; generation < 3; generation++) {
      const lifetime = new AbortController();
      const waited = owner.wait(input("repeated"), lifetime.signal, caller.signal);
      const handoff = owner.captureReloadState();
      const reason = createWorkbenchAgentMcpRuntimeReloadInterruption();
      lifetime.abort(reason);
      await assert.rejects(waited, error => error === reason);
      owner.dispose();
      owner = new WorkbenchMessageWaitController(handoff);
      assert.equal(getEventListeners(caller.signal, "abort").length, 1,
        "a detached wait needs one cleanup, not one per retired generation");
    }
    owner.receive("caller", message("first", "between generations"));
    assert.deepEqual(await owner.wait(input("repeated"), new AbortController().signal, caller.signal),
      received("first", "between generations"));
    assert.equal(getEventListeners(caller.signal, "abort").length, 0,
      "completion must release the invocation's cleanup even after reloads");
  } finally {
    caller.abort();
    owner.dispose();
  }
});

test("a completed invocation cannot delete a later wait with the same ID", async () => {
  const caller = new AbortController();
  const nextCaller = new AbortController();
  const generation = new AbortController();
  const owner = new WorkbenchMessageWaitController();
  const first = owner.wait(input("reused"), generation.signal, caller.signal);
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  generation.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
  await assert.rejects(first);
  owner.dispose();
  successor.receive("caller", message("first"));
  await successor.wait(input("reused"), new AbortController().signal, caller.signal);
  const next = successor.wait(input("reused"), nextCaller.signal);
  try {
    caller.abort();
    assert.equal(successor.hasWait("reused"), true, "old cancellation must not remove the new invocation");
    successor.receive("caller", message("second"));
    assert.deepEqual(await next, received("second"));
  } finally {
    nextCaller.abort();
    await next.catch(() => undefined);
    successor.dispose();
  }
});

test("reattaching with a different invocation signal transfers cancellation ownership", async () => {
  const caller = new AbortController();
  const replacementCaller = new AbortController();
  const generation = new AbortController();
  const owner = new WorkbenchMessageWaitController();
  const first = owner.wait(input("replacement"), generation.signal, caller.signal);
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  generation.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
  await assert.rejects(first);
  owner.dispose();
  const next = successor.wait(input("replacement"), new AbortController().signal, replacementCaller.signal);
  try {
    caller.abort();
    assert.equal(successor.hasWait("replacement"), true);
    const reason = new Error("replacement caller disconnected");
    replacementCaller.abort(reason);
    await assert.rejects(next, error => error === reason);
    assert.equal(successor.hasWait("replacement"), false);
    assert.equal(getEventListeners(replacementCaller.signal, "abort").length, 0);
  } finally {
    replacementCaller.abort();
    await next.catch(() => undefined);
    successor.dispose();
  }
});

test("message waits survive real command-generation replacement and finish their invocation lifetime", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = new WorkbenchMessageWaitController();
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  const armed = Promise.withResolvers<void>();
  const reentered = Promise.withResolvers<void>();
  const caller = new AbortController();
  const request: WorkbenchAgentCommandRequest = { method: "POST", path: "/api/message/wait", responseKind: "native" };
  const text = (outcome: Awaited<ReturnType<WorkbenchMessageWaitController["wait"]>>) => (
    outcome.kind === "message" ? outcome.message.message : "interrupted"
  );
  registry.activateCommandExecutor({}, async (command, signal) => {
    const waited = owner.wait(input("reentry"), signal, command.lifetimeSignal);
    armed.resolve();
    return new Response(text(await waited));
  });
  const result = registry.executeCommand(request, caller.signal);
  await armed.promise;
  registry.activateCommandExecutor({}, async (command, signal) => {
    const waited = successor.wait(input("reentry"), signal, command.lifetimeSignal);
    reentered.resolve();
    return new Response(text(await waited));
  });
  await reentered.promise;
  successor.receive("caller", message("first", "replacement reply"));
  assert.equal(await (await result).text(), "replacement reply");
  assert.equal(request.lifetimeSignal?.aborted, true);
  assert.equal(successor.hasWait("reentry"), false);
  owner.dispose();
  successor.dispose();
  registry.dispose();
});
