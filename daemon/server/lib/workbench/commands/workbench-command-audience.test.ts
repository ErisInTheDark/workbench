/* No production exports. Protect each command audience gate and the lazy subagent read during call admission. */
import assert from "node:assert/strict";
import test from "node:test";

import { refuseWorkbenchCommand, refuseWorkbenchCommandCaller } from "./workbench-command-audience";

const claudeOnly = { words: ["rm"], audience: { harnesses: ["claude"] as const } };
const parentOnly = { words: ["subagent", "wait"] };
const rootOnly = { words: ["tokens", "instructions"], audience: { rootOnly: true as const } };
const open = { words: ["rg"] };
const parentAtRoot = { harness: "claude", subagent: false, workbenchRoot: true };

test("each audience gate withholds its command only from the callers it names", () => {
  assert.equal(refuseWorkbenchCommand(claudeOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(claudeOnly, { ...parentAtRoot, harness: "codex" }), "harness");
  assert.equal(refuseWorkbenchCommand(parentOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(parentOnly, { ...parentAtRoot, subagent: true }), "parentOnly");
  assert.equal(refuseWorkbenchCommand(rootOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(rootOnly, { ...parentAtRoot, workbenchRoot: false }), "rootOnly");
  assert.equal(refuseWorkbenchCommand(open, { harness: "opencode", subagent: true, workbenchRoot: false }), null);
});

test("call admission reads the subagent role only for parent-only commands", async () => {
  let reads = 0;
  const isSubagent = async () => { reads += 1; return true; };
  const caller = { harness: "claude", workbenchRoot: true };
  assert.equal(await refuseWorkbenchCommandCaller(open, caller, isSubagent), null);
  assert.equal(await refuseWorkbenchCommandCaller(rootOnly, caller, isSubagent), null);
  assert.equal(reads, 0);
  assert.equal(await refuseWorkbenchCommandCaller(parentOnly, caller, isSubagent), "parentOnly");
  assert.equal(await refuseWorkbenchCommandCaller(parentOnly, caller, async () => false), null);
  assert.equal(await refuseWorkbenchCommandCaller(rootOnly, { ...caller, workbenchRoot: false }, isSubagent), "rootOnly");
  assert.equal(reads, 1);
});
