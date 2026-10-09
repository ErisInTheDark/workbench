/* No production exports. Tests protect caller workspace facts and local-capability settings for instruction selectors. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { daemonWorkspaceRoot } from "../../daemon-workspace-paths.ts";
import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";

const root = (rootPath: string) => ({ id: path.basename(rootPath), isPrimary: true, name: "root", relativePath: "root", rootPath });

test("workspace facts tell daemon scratch threads apart from project threads and single from multi-root", async () => {
  const project = await listWorkbenchInstructionMechanics({ managedThread: true, roots: [root("/repo")] });
  assert.deepEqual([...project.workspace], ["project"]);

  const workspace = await listWorkbenchInstructionMechanics({ managedThread: true, roots: [root("/repo"), root("/other")] });
  assert.deepEqual([...workspace.workspace].sort(), ["multi-root", "project"]);

  const daemon = await listWorkbenchInstructionMechanics({ managedThread: true, roots: [root(path.join(daemonWorkspaceRoot, "scratch"))] });
  assert.deepEqual([...daemon.workspace], ["daemon"]);
});

test("enabled raw Browse commands expose the browse-raw setting", async () => {
  const facts = await listWorkbenchInstructionMechanics({ managedThread: true }, async () => ({ browseRawCommandsEnabled: true }));
  assert.equal(facts.settings.has("browse-raw"), true);
  assert.equal((await listWorkbenchInstructionMechanics({ managedThread: true })).settings.has("browse-raw"), false);
});

test("failed local capability reads keep raw Browse commands unavailable and report the failure", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);

  const facts = await listWorkbenchInstructionMechanics({ managedThread: true }, async () => { throw new Error("settings unavailable"); });

  assert.equal(facts.settings.has("browse-raw"), false);
  assert.equal(reported.mock.callCount(), 1);
  assert.doesNotMatch(String(reported.mock.calls[0]?.arguments[0]), /settings unavailable/u);
});
