/* No production exports. Tests protect managed-thread and local-capability mechanic availability. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";

test("installed managed capabilities do not depend on a native identity or caller origin", async () => {
  for (const subagentName of [null, "Akari"]) {
    const promptContext = { managedThread: true, threadId: null, subagentName };
    const available = await listWorkbenchInstructionMechanics(promptContext);
    for (const mechanic of ["browse", "long-waits", "subagents", "task-status", "thread-git", "thread-recall", "thread-refresh"]) {
      assert.equal(available.has(mechanic), true, mechanic);
    }
    assert.equal(available.has("task-title"), subagentName === null);
    assert.equal(available.has("browse-raw"), false);
  }
  assert.equal((await listWorkbenchInstructionMechanics({})).has("task-title"), false);
});

test("managed top-level threads expose current-thread mechanics before and after materialization", async () => {
  for (const threadId of ["new", "draft:123", "thread-1"]) {
    const promptContext = { harness: "codex" as const, threadId, workbenchOrigin: "http://localhost" };
    const available = await listWorkbenchInstructionMechanics(promptContext);
    for (const mechanic of ["long-waits", "task-title", "task-status", "thread-git", "thread-recall", "thread-refresh"]) {
      assert.equal(available.has(mechanic), true, `${threadId} should expose ${mechanic}`);
    }
    assert.equal(available.has("browse-raw"), false);
  }

  const subagentContext = { harness: "codex" as const, subagentName: "Akari", threadId: "draft:child", workbenchOrigin: "http://localhost" };
  const subagent = await listWorkbenchInstructionMechanics(subagentContext);
  assert.equal(subagent.has("task-title"), false);
  assert.equal(subagent.has("task-status"), true);
  assert.equal(subagent.has("thread-git"), true);
  assert.equal(subagent.has("thread-recall"), true);
  assert.equal(subagent.has("thread-refresh"), true);
});

test("enabled raw Browse commands expose the browse-raw mechanic", async () => {
  const available = await listWorkbenchInstructionMechanics({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  }, async () => ({ browseRawCommandsEnabled: true }));

  assert.equal(available.has("browse-raw"), true);
});

test("failed local capability reads keep raw Browse commands unavailable and report the failure", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);

  const available = await listWorkbenchInstructionMechanics({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  }, async () => { throw new Error("settings unavailable"); });

  assert.equal(available.has("browse-raw"), false);
  assert.equal(reported.mock.callCount(), 1);
  assert.doesNotMatch(String(reported.mock.calls[0]?.arguments[0]), /settings unavailable/u);
});
