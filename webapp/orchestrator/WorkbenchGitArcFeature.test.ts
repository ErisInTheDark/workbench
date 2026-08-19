/*
 * Exports:
 * - No production exports; feature tests prove repository-wide Git arc transition serialization. Keywords: git, arc, orchestrator, transition, concurrency, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";

test("sibling threads in one worktree share the Git arc transition lane", async () => {
  const keys: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadClaim: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: {
      run: async (key: string) => {
        keys.push(key);
        throw new Error("stop after capturing the transition key");
      },
    },
  });
  const request = {
    action: "compare",
    checkpointCommit: "a".repeat(40),
    cwd: "ignored after validation",
  } as const;

  await feature.executeRequest({ ...request, harness: "codex", threadId: "thread-one" });
  await feature.executeRequest({ ...request, harness: "opencode", threadId: "thread-two" });

  assert.deepEqual(keys, ["git-arc\0c:/git/project", "git-arc\0c:/git/project"]);
});

test("settled threads cannot start claims", async () => {
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
      title: "Finished thread",
    }),
    refreshThreadClaim: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const response = await feature.executeRequest({
    action: "arcStart",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "thread-one",
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /settled thread cannot start or continue/u);
});

test("successful Git responses survive a failed thread claim refresh", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadClaim: async () => { throw new Error("projection exploded"); },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => Response.json({ proposalId: "proposal-one" }),
  });

  const response = await feature.executeRequest({
    action: "proposalCreate",
    amend: false,
    cwd: "C:/Git/Project",
    description: "",
    harness: "codex",
    threadId: "thread-one",
    title: "Proposal",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposalId: "proposal-one" });
  assert.equal(reported.mock.callCount(), 1);
  assert.match(String(reported.mock.calls[0]?.arguments[0]), /operation succeeded.*projection exploded/u);
});
