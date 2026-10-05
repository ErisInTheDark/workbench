/*
 * Exports: none. Protect message sender/recipient filtering, first-match delivery, independent waits, cancellation, and reload continuity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchMessageWaitController from "./WorkbenchMessageWaitController";
import { createWorkbenchAgentMcpRuntimeReloadInterruption } from "./lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchAgentCommandRequest } from "./lib/workbench/commands/workbench-agent-command-definition";
import { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

const id = WorkbenchThreadIdSchema.parse;
const input = (waitId: string, caller = "caller", senders = ["first", "second"]) => ({
  waitId, callerThreadId: id(caller), senderThreadIds: senders.map(sender => id(sender)),
});
const message = (senderThreadId: string, text = "reply") => ({ senderThreadId, senderName: "luna", message: text });

test("message waits ignore earlier messages and other recipients or senders, and retain the first matching reply", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  owner.receive("caller", message("first", "before arming"));
  const waited = owner.wait(input("wait"), signal);
  owner.receive("other-caller", message("first", "wrong recipient"));
  owner.receive("caller", message("unselected", "wrong sender"));
  owner.receive("caller", message("second", "first matching reply"));
  owner.receive("caller", message("first", "later matching reply"));
  assert.deepEqual(await waited, message("second", "first matching reply"));
  owner.dispose();
});

test("simultaneous waits observe messages independently without consuming delivery", async () => {
  const owner = new WorkbenchMessageWaitController();
  const signal = new AbortController().signal;
  const first = owner.wait(input("one", "caller", ["first"]), signal);
  const second = owner.wait(input("two", "caller", ["second"]), signal);
  const overlapping = owner.wait(input("three", "caller", ["first", "second"]), signal);
  owner.receive("caller", message("first"));
  assert.deepEqual(await first, message("first"));
  assert.deepEqual(await overlapping, message("first"));
  owner.receive("caller", message("second"));
  assert.deepEqual(await second, message("second"));
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
    new AbortController().signal, caller.signal), message("second", "during reload"));
  assert.equal(successor.hasWait("reload"), false);
  caller.abort();
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
  owner.dispose();
  successor.dispose();
});

test("message waits survive real command-generation replacement and finish their invocation lifetime", async () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = new WorkbenchMessageWaitController();
  const successor = new WorkbenchMessageWaitController(owner.captureReloadState());
  const armed = Promise.withResolvers<void>();
  const reentered = Promise.withResolvers<void>();
  const caller = new AbortController();
  const request: WorkbenchAgentCommandRequest = { method: "POST", path: "/api/message/wait", responseKind: "native" };
  registry.activateCommandExecutor({}, async (command, signal) => {
    const waited = owner.wait(input("reentry"), signal, command.lifetimeSignal);
    armed.resolve();
    return new Response((await waited).message);
  });
  const result = registry.executeCommand(request, caller.signal);
  await armed.promise;
  registry.activateCommandExecutor({}, async (command, signal) => {
    const waited = successor.wait(input("reentry"), signal, command.lifetimeSignal);
    reentered.resolve();
    return new Response((await waited).message);
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
