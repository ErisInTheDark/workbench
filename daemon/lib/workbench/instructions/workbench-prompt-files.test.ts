/* No production exports. Tests protect managed-thread and local-capability mechanic availability. */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchServerSettings from "../settings/WorkbenchServerSettings";
import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";

test("installed managed capabilities do not depend on a native identity or caller origin", async (context) => {
  context.mock.method(WorkbenchServerSettings.prototype, "readLocalCapabilities", async () => ({ browseRawCommandsEnabled: false }));
  for (const subagentName of [null, "Akari"]) {
    const promptContext = { managedThread: true, threadId: null, subagentName };
    const available = await listWorkbenchInstructionMechanics(promptContext);
    for (const mechanic of ["browse", "long-waits", "subagents", "thread-status", "thread-git", "thread-recall", "thread-refresh"]) {
      assert.equal(available.has(mechanic), true, mechanic);
    }
    assert.equal(available.has("thread-title"), subagentName === null);
    assert.equal(available.has("browse-raw"), false);
  }
  assert.equal((await listWorkbenchInstructionMechanics({})).has("thread-title"), false);
});

test("managed top-level threads expose current-thread mechanics before and after materialization", async (context) => {
  context.mock.method(
    WorkbenchServerSettings.prototype,
    "readLocalCapabilities",
    async () => ({ browseRawCommandsEnabled: false }),
  );
  for (const threadId of ["new", "draft:123", "thread-1"]) {
    const promptContext = { harness: "codex" as const, threadId, workbenchOrigin: "http://localhost" };
    const available = await listWorkbenchInstructionMechanics(promptContext);
    for (const mechanic of ["long-waits", "thread-title", "thread-status", "thread-git", "thread-recall", "thread-refresh"]) {
      assert.equal(available.has(mechanic), true, `${threadId} should expose ${mechanic}`);
    }
    assert.equal(available.has("browse-raw"), false);
  }

  const subagentContext = { harness: "codex" as const, subagentName: "Akari", threadId: "draft:child", workbenchOrigin: "http://localhost" };
  const subagent = await listWorkbenchInstructionMechanics(subagentContext);
  assert.equal(subagent.has("thread-title"), false);
  assert.equal(subagent.has("thread-status"), true);
  assert.equal(subagent.has("thread-git"), true);
  assert.equal(subagent.has("thread-recall"), true);
  assert.equal(subagent.has("thread-refresh"), true);
});

test("enabled raw Browse commands expose the browse-raw mechanic", async (context) => {
  context.mock.method(
    WorkbenchServerSettings.prototype,
    "readLocalCapabilities",
    async () => ({ browseRawCommandsEnabled: true }),
  );

  const available = await listWorkbenchInstructionMechanics({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });

  assert.equal(available.has("browse-raw"), true);
});

test("failed local capability reads keep raw Browse commands unavailable and report the failure", async (context) => {
  context.mock.method(
    WorkbenchServerSettings.prototype,
    "readLocalCapabilities",
    async () => { throw new Error("settings unavailable"); },
  );
  const reported = context.mock.method(console, "error", () => undefined);

  const available = await listWorkbenchInstructionMechanics({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });

  assert.equal(available.has("browse-raw"), false);
  assert.equal(reported.mock.callCount(), 1);
  assert.doesNotMatch(String(reported.mock.calls[0]?.arguments[0]), /settings unavailable/u);
});
