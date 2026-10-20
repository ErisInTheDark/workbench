/*
 * No production exports. Protects app network event conformance: envelopes repair, payloads arrive conformed, invalid payloads reject.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { conformWorkbenchAppNetworkEvent } from "./workbench-app-events";

const delta = {
  subscriptionId: "6a0b7a64-63c6-4f7e-9d0f-0c2a1f4f7c11", generation: 1, kind: "thread", baseRevision: 1, revision: 2,
  delta: { set: { phase: "current" } },
};

test("workspace delta events repair their envelope once and keep their conformed delta", () => {
  const repaired = conformWorkbenchAppNetworkEvent({ kind: "workspaceDelta", delta, stray: true });
  assert.equal(repaired.success, true);
  assert.deepEqual(repaired.success && repaired.data, { kind: "workspaceDelta", delta });
  assert.deepEqual(repaired.repairedPaths, [["stray"]]);

  const invalid = conformWorkbenchAppNetworkEvent({ kind: "workspaceDelta", delta: { ...delta, delta: { set: "nope" } } });
  assert.equal(invalid.success, false);
});
