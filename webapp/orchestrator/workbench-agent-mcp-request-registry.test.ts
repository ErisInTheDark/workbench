/* No production exports. Tests protect isolated registry lifecycle and reload-stable process cancellation. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  WorkbenchAgentMcpRequestRegistry,
} from "./workbench-agent-mcp-request-registry";

test("isolated registry rejects duplicate IDs and aborts active work on disposal", () => {
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const registration = registry.register("request-1");
  assert.throws(() => registry.register("request-1"), /already active/u);
  assert.equal(registration.signal.aborted, false);
  registry.dispose();
  assert.equal(registration.signal.aborted, true);
  assert.match(String(registration.signal.reason), /shutting down/u);
  assert.throws(() => registry.register("request-2"), /disposed/u);
  registration.unregister();
});

test("process registry routes cancellation across wrapper generations", () => {
  const requestId = `reload-${process.pid}-${Date.now()}`;
  const admitted = getProcessWorkbenchAgentMcpRequestRegistry();
  const registration = admitted.register(requestId);
  const reloaded = getProcessWorkbenchAgentMcpRequestRegistry();
  try {
    assert.equal(reloaded.cancel(requestId, "new generation cancelled it"), true);
    assert.equal(registration.signal.aborted, true);
    assert.match(String(registration.signal.reason), /new generation/u);
  } finally {
    registration.unregister();
  }
});
