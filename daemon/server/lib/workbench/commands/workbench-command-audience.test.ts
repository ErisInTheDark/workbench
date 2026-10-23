/* No production exports. Protect each command audience gate and the lazy subagent and capability reads during call admission. */
import assert from "node:assert/strict";
import test from "node:test";

import { refuseWorkbenchCommand, refuseWorkbenchCommandCaller } from "./workbench-command-audience";

const claudeOnly = { words: ["rm"], audience: { harnesses: ["claude"] as const } };
const parentOnly = { words: ["subagent", "wait"] };
const rootOnly = { words: ["tokens", "instructions"], audience: { rootOnly: true as const } };
const gated = { words: ["browse", "raw"], audience: { requiresCapability: "browseRawCommandsEnabled" as const } };
const open = { words: ["rg"] };
const enabled = { browseRawCommandsEnabled: true };
const disabled = { browseRawCommandsEnabled: false };
const parentAtRoot = { harness: "claude", subagent: false, workbenchRoot: true, capabilities: enabled };

test("each audience gate withholds its command only from the callers it names", () => {
  assert.equal(refuseWorkbenchCommand(claudeOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(claudeOnly, { ...parentAtRoot, harness: "codex" }), "harness");
  assert.equal(refuseWorkbenchCommand(parentOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(parentOnly, { ...parentAtRoot, subagent: true }), "parentOnly");
  assert.equal(refuseWorkbenchCommand(rootOnly, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(rootOnly, { ...parentAtRoot, workbenchRoot: false }), "rootOnly");
  assert.equal(refuseWorkbenchCommand(gated, parentAtRoot), null);
  assert.equal(refuseWorkbenchCommand(gated, { ...parentAtRoot, capabilities: disabled }), "capability");
  assert.equal(refuseWorkbenchCommand(gated, { ...parentAtRoot, capabilities: null }), null, "unknown capabilities defer to admission");
  assert.equal(refuseWorkbenchCommand(open, { harness: "opencode", subagent: true, workbenchRoot: false, capabilities: disabled }), null);
});

test("call admission reads the subagent role and capabilities only for commands they gate", async () => {
  let subagentReads = 0;
  let capabilityReads = 0;
  const readers = (capabilities = disabled) => ({
    isSubagent: async () => { subagentReads += 1; return true; },
    readCapabilities: async () => { capabilityReads += 1; return capabilities; },
  });
  const caller = { harness: "claude", workbenchRoot: true };
  assert.equal(await refuseWorkbenchCommandCaller(open, caller, readers()), null);
  assert.equal(await refuseWorkbenchCommandCaller(rootOnly, caller, readers()), null);
  assert.equal(subagentReads + capabilityReads, 0);
  assert.equal(await refuseWorkbenchCommandCaller(parentOnly, caller, readers()), "parentOnly");
  assert.equal(await refuseWorkbenchCommandCaller(parentOnly, caller, { ...readers(), isSubagent: async () => false }), null);
  assert.equal(await refuseWorkbenchCommandCaller(rootOnly, { ...caller, workbenchRoot: false }, readers()), "rootOnly");
  assert.equal(subagentReads, 1);
  assert.equal(capabilityReads, 0);
  assert.equal(await refuseWorkbenchCommandCaller(gated, caller, readers()), "capability");
  assert.equal(await refuseWorkbenchCommandCaller(gated, caller, readers(enabled)), null);
  assert.equal(capabilityReads, 2);
});
