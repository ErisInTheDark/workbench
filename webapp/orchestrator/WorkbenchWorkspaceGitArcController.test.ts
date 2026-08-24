/* No production exports. Real-Git tests protect workspace arc membership, root-qualified projection, repo deduplication, and per-root proposals. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type WorkbenchGitCheckpointController from "../lib/workbench/git/WorkbenchGitCheckpointController";
import { WorkbenchGitArcLifecycleStateSchema, WorkbenchGitArcPlanStateSchema } from "../lib/workbench/thread/thread-state";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import WorkbenchWorkspaceGitArcController from "./WorkbenchWorkspaceGitArcController";

class FakeLocalGitArcController {
  private nextProposal = 0;
  private readonly plans = new Map<string, { checkpointCommit: string; harness: string; intentDescription: string; intentName: string; scopePaths: string[]; threadId: string; updatedAt: string }>();
  private readonly proposals = new Map<string, { paths: string[]; proposalId: string }>();
  private readonly states = new Map<string, {
    checkpointCommit: string; claimedPaths: string[]; harness: string; intentDescription: string; intentName: string;
    phase: "active"; proposals: Array<{ proposalId: string; status: "proposed" }>; threadId: string; updatedAt: string;
  }>();

  async createPlan(input: { cwd: string; harness: string; intentDescription: string; intentName: string; paths: string[]; threadId: string }) {
    const checkpointCommit = input.cwd.toLowerCase().includes("fixture-copy")
      ? `${String(this.plans.size + 1).repeat(40).slice(0, 40)}`
      : "a".repeat(40);
    const scopePaths = input.paths.map((filePath) => path.relative(input.cwd, filePath).replace(/\\/gu, "/")).sort();
    this.plans.set(input.cwd, {
      checkpointCommit, harness: input.harness, intentDescription: input.intentDescription, intentName: input.intentName,
      scopePaths, threadId: input.threadId, updatedAt: "2026-08-24T00:00:00.000Z",
    });
    return { checkpointCommit, checkpointRef: `refs/${checkpointCommit}`, intentName: input.intentName, kind: "plan", repoRoot: input.cwd, scopePaths };
  }

  async startArc(input: { cwd: string }) {
    const plan = this.plans.get(input.cwd)!;
    this.states.set(input.cwd, {
      checkpointCommit: plan.checkpointCommit,
      claimedPaths: plan.scopePaths,
      harness: plan.harness,
      intentDescription: plan.intentDescription,
      intentName: plan.intentName,
      phase: "active",
      proposals: [],
      threadId: plan.threadId,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    return { checkpointCommit: plan.checkpointCommit, checkpointRef: `refs/${plan.checkpointCommit}`, changes: [], intentName: plan.intentName, repoRoot: input.cwd, scopePaths: plan.scopePaths };
  }

  async compare(input: { cwd: string }) {
    const state = this.states.get(input.cwd)!;
    return {
      changes: state.claimedPaths.map((filePath) => ({ additions: 1, deletions: 0, kind: { type: "update" }, path: filePath })),
      checkpointCommit: state.checkpointCommit, checkpointRef: `refs/${state.checkpointCommit}`, intentName: state.intentName,
      repoRoot: input.cwd, scopePaths: state.claimedPaths,
    };
  }

  async findLifecycleState(input: { cwd: string }) { return this.states.get(input.cwd) ?? null; }
  async listLifecycleStates(input: { cwd: string }) { return this.states.has(input.cwd) ? [this.states.get(input.cwd)!] : []; }
  async findPlanState(input: { cwd: string }) { return this.plans.get(input.cwd) ?? null; }
  async listPlanStates(input: { cwd: string }) { return this.plans.has(input.cwd) ? [this.plans.get(input.cwd)!] : []; }

  async createProposal(input: { cwd: string; paths?: string[] }) {
    const state = this.states.get(input.cwd)!;
    const proposalId = `proposal-${++this.nextProposal}`;
    const paths = (input.paths ?? state.claimedPaths).map((filePath) => path.isAbsolute(filePath)
      ? path.relative(input.cwd, filePath).replace(/\\/gu, "/")
      : filePath);
    this.proposals.set(proposalId, { paths, proposalId });
    state.proposals.push({ proposalId, status: "proposed" });
    return { baseCommit: "f".repeat(40), description: "", includeNewer: false, paths, proposalId, status: "proposed", title: proposalId };
  }

  async getProposal(input: { proposalId: string }) { return this.proposals.get(input.proposalId)!; }
}

function createWorkspace(primary: string, secondary: string): AgentEndpointProjectResolution {
  const roots = [
    { id: "api", name: "API", root: primary, rootPath: primary },
    { id: "web", name: "Web", root: secondary, rootPath: secondary },
  ];
  return {
    cwd: primary,
    project: { id: "workspace", kind: "workspace", root: primary, rootPath: primary, roots },
    root: roots[0]!,
  };
}

test("one workspace arc aggregates two repositories and keeps proposals root-specific", async () => {
  const apiRoot = "C:/workspace/api";
  const webRoot = "C:/workspace/web";
  const project = createWorkspace(apiRoot, webRoot);
  const controller = new WorkbenchWorkspaceGitArcController(
    new FakeLocalGitArcController() as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: apiRoot, harness: "codex" as const, threadId: "workspace-thread" };

  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "Change both projects.",
    intentName: "multi-project change",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["one.txt"], rootId: "api" },
      { adoptPaths: [], paths: ["two.txt"], rootId: "web" },
    ],
    ...identity,
  }) as unknown as { members: Array<{ checkpointCommit: string; rootId: string }>; scopePaths: string[] };

  assert.deepEqual(plan.scopePaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(plan.members.map(({ rootId }) => rootId), ["api", "web"]);
  const plannedState = await controller.findPlanState(project, "codex", identity.threadId);
  assert.ok(plannedState);
  const { harness: _planHarness, threadId: _planThreadId, ...sidebarPlan } = plannedState;
  assert.doesNotThrow(() => WorkbenchGitArcPlanStateSchema.parse(sidebarPlan));
  const refs = plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId }));
  await controller.execute(project, { action: "arcStart", refs, ...identity });

  const comparison = await controller.execute(project, {
    action: "compare", refs: [], roots: [], ...identity,
  }) as { changes: Array<{ path: string }> };
  assert.deepEqual(comparison.changes.map(({ path: filePath }) => filePath), ["api:one.txt", "web:two.txt"]);

  await assert.rejects(controller.execute(project, {
    action: "proposalCreate", amend: false, description: "", title: "ambiguous proposal", ...identity,
  }), /requires rootId/u);
  const apiProposal = await controller.execute(project, {
    action: "proposalCreate", amend: false, description: "", rootId: "api", title: "change api", ...identity,
  }) as { proposalId: string; rootId: string };
  const webProposal = await controller.execute(project, {
    action: "proposalCreate", amend: false, description: "", rootId: "web", title: "change web", ...identity,
  }) as { proposalId: string; rootId: string };
  assert.equal(apiProposal.rootId, "api");
  assert.equal(webProposal.rootId, "web");

  const lifecycle = await controller.findLifecycleState(project, "codex", identity.threadId);
  assert.ok(lifecycle);
  const { harness: _arcHarness, threadId: _arcThreadId, ...sidebarLifecycle } = lifecycle;
  assert.deepEqual(WorkbenchGitArcLifecycleStateSchema.parse(sidebarLifecycle).claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.proposals.map(({ proposalId, rootId }) => ({ proposalId, rootId })), [
    { proposalId: apiProposal.proposalId, rootId: "api" },
    { proposalId: webProposal.proposalId, rootId: "web" },
  ]);
});

test("workspace roots in one repository share one member while keeping qualified root paths", async () => {
  const repoRoot = "C:/workspace/repo";
  const project = createWorkspace(repoRoot, path.join(repoRoot, "nested"));
  project.project.roots.push({ id: "docs", name: "Docs", root: path.join(repoRoot, "docs"), rootPath: path.join(repoRoot, "docs") });
  const controller = new WorkbenchWorkspaceGitArcController(
    new FakeLocalGitArcController() as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async () => repoRoot,
  );
  const result = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    cwd: repoRoot,
    harness: "codex",
    intentDescription: "",
    intentName: "shared repository roots",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["ordinary.txt"], rootId: "api" },
      { adoptPaths: [], paths: ["one.txt"], rootId: "web" },
    ],
    threadId: "shared-repository-thread",
  }) as unknown as { members: Array<{ checkpointCommit: string }>; scopePaths: string[] };

  assert.equal(result.members.length, 1);
  assert.deepEqual(result.scopePaths, ["api:ordinary.txt", "web:one.txt"]);
  await controller.execute(project, {
    action: "arcStart", cwd: repoRoot, harness: "codex", refs: [{ ref: result.members[0]!.checkpointCommit, rootId: "api" }],
    threadId: "shared-repository-thread",
  });
  const webProposal = await controller.execute(project, {
    action: "proposalCreate", amend: false, cwd: repoRoot, description: "", harness: "codex", rootId: "web",
    threadId: "shared-repository-thread", title: "change web",
  }) as { paths: string[] };
  assert.deepEqual(webProposal.paths, ["nested/one.txt"]);
  await assert.rejects(controller.execute(project, {
    action: "proposalCreate", amend: false, cwd: repoRoot, description: "", harness: "codex", paths: ["web:one.txt"], rootId: "api",
    threadId: "shared-repository-thread", title: "cross-root proposal",
  }), /cannot include paths from another workspace root/u);
  await assert.rejects(controller.execute(project, {
    action: "proposalCreate", amend: false, cwd: repoRoot, description: "", harness: "codex", rootId: "docs",
    threadId: "shared-repository-thread", title: "empty-root proposal",
  }), /has no claimed paths to propose/u);
});
