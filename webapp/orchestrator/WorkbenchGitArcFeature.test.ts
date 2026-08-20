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

test("arc move previews do not refresh claims while applied moves do", async () => {
  let refreshCount = 0;
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadClaim: async () => { refreshCount += 1; },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", { value: async () => Response.json({ ok: true }) });

  const common = { cwd: "C:/Git/Project", harness: "codex", threadId: "thread-one" } as const;
  assert.equal((await feature.executeRequest({
    action: "arcMove",
    move: { confirm: false, kind: "regex", pattern: "^src/(.+)$", replacement: "tests/$1", roots: ["src"] },
    ...common,
  })).status, 200);
  assert.equal(refreshCount, 0);

  assert.equal((await feature.executeRequest({
    action: "arcMove",
    move: { kind: "operands", operands: ["src/a.ts", "tests/a.ts"] },
    ...common,
  })).status, 200);
  assert.equal(refreshCount, 1);
});

test("reloadable Git arc dispatch owns current-plan and proposal lifecycle actions", async () => {
  const calls: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Thread",
    }),
    refreshThreadClaim: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const internal = (feature as unknown as { controller: Record<string, (...args: never[]) => Promise<object>> }).controller;
  for (const method of ["createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "startArc", "rescindProposal", "diff", "createProposal"] as const) {
    internal[method] = async () => { calls.push(method); return {}; };
  }
  const common = { cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread-one" };
  const requests = [
    { action: "plan", intentDescription: "", intentName: "draft", paths: [], ...common },
    { action: "planAdd", paths: ["src/a.ts"], ...common },
    { action: "planRemove", paths: ["src/a.ts"], ...common },
    { action: "planAdopt", paths: ["src/dirty.ts"], ...common },
    { action: "planStart", intentDescription: "", intentName: "start", paths: ["src/a.ts"], ...common },
    { action: "arcStart", ...common },
    { action: "proposalRescind", proposalId: "proposal-one", ...common },
    { action: "diff", checkpointCommit: "abcdef1", paths: ["src/a.ts"], ...common },
    { action: "proposalCreate", amendProposalId: "proposal-one", description: "", title: "amend", ...common },
  ];
  const statuses = await Promise.all(requests.map(async (request) => (await feature.executeRequest(request)).status));
  assert.deepEqual(statuses, Array.from({ length: requests.length }, () => 200));
  assert.deepEqual([...calls].sort(), [
    "createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "startArc", "rescindProposal", "diff", "createProposal",
  ].sort());
});
