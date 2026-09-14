/*
 * No production exports. Tests protect graph-definition ownership from acquiring reload or harness lifecycle state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTopologyNode from "./WorkbenchTopologyNode";

test("the topology node is an atomic graph marker without reload state", () => {
  assert.equal(WorkbenchTopologyNode.scope, "server:topology");
  assert.equal(WorkbenchTopologyNode.lifecycle, "atomic");
  assert.deepEqual(WorkbenchTopologyNode.provides, []);
  assert.deepEqual(WorkbenchTopologyNode.requires, []);
  assert.equal(WorkbenchTopologyNode.children.some(({ scope }) => scope.startsWith("harness:")), false);
  const instance = WorkbenchTopologyNode.create({} as never, {
    get: () => { throw new Error("topology must not read runtime registrations"); },
    run: () => { throw new Error("Unexpected graph operation in node fixture"); },
    handoffState: undefined,
    isReplacing: () => true,
    lease: { isCurrent: () => true },
    mode: "initial",
  });
  assert.deepEqual(instance.registrations, {});
});
