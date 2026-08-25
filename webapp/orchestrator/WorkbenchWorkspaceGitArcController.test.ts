/* No production exports. Tests protect workspace arc membership, root-qualified projection, repo deduplication, per-root proposals, and proposal-owned amendment routing. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
  private readonly proposals = new Map<string, { cwd: string; paths: string[]; proposalId: string }>();
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

  async createProposal(input: { amendProposalId?: string; cwd: string; paths?: string[] }) {
    const state = this.states.get(input.cwd);
    const proposalId = `proposal-${++this.nextProposal}`;
    const amendmentPaths = input.amendProposalId ? this.proposals.get(input.amendProposalId)?.paths : undefined;
    const paths = (input.paths ?? amendmentPaths ?? state?.claimedPaths ?? []).map((filePath) => path.isAbsolute(filePath)
      ? path.relative(input.cwd, filePath).replace(/\\/gu, "/")
      : filePath);
    this.proposals.set(proposalId, { cwd: input.cwd, paths, proposalId });
    state?.proposals.push({ proposalId, status: "proposed" });
    return {
      baseCommit: "f".repeat(40), description: "", includeNewer: false, paths, proposalId,
      receivedPaths: input.paths, status: "proposed", title: proposalId,
    };
  }

  async getProposal(input: { cwd: string; proposalId: string }) {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.cwd !== input.cwd) throw new Error(`Git arc proposal not found: ${input.proposalId}`);
    return proposal;
  }
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

test("active claims cover exact files and existing directory descendants across workspace roots", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-claim-coverage-"));
  context.after(async () => await rm(temporaryRoot, { force: true, recursive: true }));
  const apiRoot = path.join(temporaryRoot, "api");
  const webRoot = path.join(temporaryRoot, "web");
  const apiSource = path.join(apiRoot, "src");
  await mkdir(apiSource, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(apiSource, "nested.ts"), "export {};\n", "utf8");
  await writeFile(path.join(webRoot, "claimed.ts"), "export {};\n", "utf8");
  const project = createWorkspace(apiRoot, webRoot);
  const controller = new WorkbenchWorkspaceGitArcController(
    new FakeLocalGitArcController() as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: apiRoot, harness: "codex" as const, threadId: "claim-thread" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "Protect patch paths.",
    intentName: "claim coverage",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["src", "future.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["claimed.ts"], rootId: "web" },
    ],
    ...identity,
  }) as unknown as { members: Array<{ checkpointCommit: string; rootId: string }> };
  await controller.execute(project, {
    action: "arcStart",
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  });

  const covered = [
    path.join(apiSource, "nested.ts"),
    path.join(apiSource, "new.ts"),
    path.join(apiRoot, "future.ts"),
    path.join(webRoot, "claimed.ts"),
  ];
  assert.deepEqual(await controller.checkActiveClaimPaths(project, "codex", identity.threadId, covered), {
    allowed: true,
    uncoveredPaths: [],
  });
  if (process.platform === "win32") {
    assert.deepEqual(await controller.checkActiveClaimPaths(project, "codex", identity.threadId, covered.map((filePath) => filePath.toLowerCase())), {
      allowed: true,
      uncoveredPaths: [],
    });
  }
  const uncovered = [path.join(apiRoot, "sibling.ts"), path.join(webRoot, "destination.ts"), path.join(temporaryRoot, "outside.ts")];
  assert.deepEqual(await controller.checkActiveClaimPaths(project, "codex", identity.threadId, uncovered), {
    allowed: false,
    uncoveredPaths: uncovered,
  });
  assert.deepEqual(await controller.checkActiveClaimPaths(project, "codex", "no-active-arc", covered), {
    allowed: false,
    uncoveredPaths: covered,
  });
});

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
  const messageAmendment = await controller.execute(project, {
    action: "proposalCreate", amend: false, amendProposalId: webProposal.proposalId,
    description: "Replacement description", title: "Replacement title", ...identity,
  }) as { paths: string[]; proposalId: string; receivedPaths?: string[]; rootId: string };
  assert.deepEqual({
    paths: messageAmendment.paths,
    receivedPaths: messageAmendment.receivedPaths,
    rootId: messageAmendment.rootId,
  }, {
    paths: ["two.txt"],
    receivedPaths: undefined,
    rootId: "web",
  });

  const lifecycle = await controller.findLifecycleState(project, "codex", identity.threadId);
  assert.ok(lifecycle);
  const { harness: _arcHarness, threadId: _arcThreadId, ...sidebarLifecycle } = lifecycle;
  assert.deepEqual(WorkbenchGitArcLifecycleStateSchema.parse(sidebarLifecycle).claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.proposals.map(({ proposalId, rootId }) => ({ proposalId, rootId })), [
    { proposalId: apiProposal.proposalId, rootId: "api" },
    { proposalId: webProposal.proposalId, rootId: "web" },
    { proposalId: messageAmendment.proposalId, rootId: "web" },
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
