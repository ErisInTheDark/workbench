/* No production exports. Tests protect caller workspace facts and the capability read that gates capability-bound tools. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { daemonWorkspaceRoot } from "../../daemon-workspace-paths.ts";
import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";
import { readWorkbenchInstructionCapabilities } from "./workbench-instruction-mechanics.ts";

const root = (rootPath: string) => ({ id: path.basename(rootPath), isPrimary: true, name: "root", relativePath: "root", rootPath });

test("workspace facts tell daemon scratch threads apart from project threads and single from multi-root", () => {
  const project = listWorkbenchInstructionMechanics({ managedThread: true, roots: [root("/repo")] });
  assert.deepEqual([...project.workspace], ["project"]);

  const workspace = listWorkbenchInstructionMechanics({ managedThread: true, roots: [root("/repo"), root("/other")] });
  assert.deepEqual([...workspace.workspace].sort(), ["multi-root", "project"]);

  const daemon = listWorkbenchInstructionMechanics({ managedThread: true, roots: [root(path.join(daemonWorkspaceRoot, "scratch"))] });
  assert.deepEqual([...daemon.workspace], ["daemon"]);
});

test("failed local capability reads keep capability-gated tools unavailable and report the failure", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);

  const capabilities = await readWorkbenchInstructionCapabilities(async () => { throw new Error("settings unavailable"); });

  assert.equal(capabilities.browseRawCommandsEnabled, false);
  assert.equal(reported.mock.callCount(), 1);
  assert.doesNotMatch(String(reported.mock.calls[0]?.arguments[0]), /settings unavailable/u);
});
