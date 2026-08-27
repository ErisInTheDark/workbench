/* No production exports. Tests protect isolated identity, generation-scoped drain policy, diagnostics, and reload-stable cancellation. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  WorkbenchAgentMcpRequestRegistry,
} from "./workbench-agent-mcp-request-registry";

function registrationOptions(owner: object, toolName = "thread_title_get") {
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

test("thread steers interrupt only declared waits for the matching thread across clients and owners", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const firstOwner = {};
  const secondOwner = {};
  const subagentWait = registry.register("client-1", 1, {
    owner: firstOwner,
    steerInterruptible: true,
    threadId: "parent-thread",
    toolName: "subagent_wait",
  });
  const secondWait = registry.register("client-2", 1, {
    owner: secondOwner,
    steerInterruptible: true,
    threadId: "parent-thread",
    toolName: "subagent_wait",
  });
  const otherThreadWait = registry.register("client-1", 2, {
    owner: firstOwner,
    steerInterruptible: true,
    threadId: "other-thread",
    toolName: "subagent_wait",
  });
  const ordinaryCall = registry.register("client-2", 2, {
    owner: secondOwner,
    threadId: "parent-thread",
    toolName: "thread_title_get",
  });

  assert.equal(registry.interruptThreadWaits("parent-thread"), 2);
  assert.equal(subagentWait.signal.aborted, true);
  assert.equal(secondWait.signal.aborted, true);
  assert.equal(otherThreadWait.signal.aborted, false);
  assert.equal(ordinaryCall.signal.aborted, false);
  assert.equal(registry.interruptThreadWaits("parent-thread"), 0);
  assert.throws(() => registry.register("client-3", 1, {
    owner: {},
    steerInterruptible: true,
    toolName: "subagent_wait",
  }), /requires a thread id/u);

  subagentWait.unregister();
  secondWait.unregister();
  otherThreadWait.unregister();
  ordinaryCall.unregister();
});

test("thread wait observation derives every active interruptible tool from live registrations", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const states: Array<{ threadId: string; toolNames: string[] }> = [];
  const stop = registry.subscribeThreadWaits((state) => states.push(state));
  const owner = {};
  const subagent = registry.register("client-1", 1, {
    owner, steerInterruptible: true, threadId: "parent-thread", toolName: "subagent_wait",
  });
  const arc = registry.register("client-2", 1, {
    owner, steerInterruptible: true, threadId: "parent-thread", toolName: "git_arc_wait",
  });
  const ordinary = registry.register("client-1", 2, {
    owner, threadId: "parent-thread", toolName: "thread_title_get",
  });
  arc.unregister();
  subagent.unregister();
  ordinary.unregister();
  stop();
  assert.deepEqual(states, [
    { threadId: "parent-thread", toolNames: ["subagent_wait"] },
    { threadId: "parent-thread", toolNames: ["git_arc_wait", "subagent_wait"] },
    { threadId: "parent-thread", toolNames: ["subagent_wait"] },
    { threadId: "parent-thread", toolNames: [] },
  ]);
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

test("released runtime owners reject late request admission", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const owner = {};
  registry.releaseRuntimeOwner(owner);
  assert.throws(() => registry.register("client-1", 1, registrationOptions(owner)), /runtime owner is disposed/u);
});
