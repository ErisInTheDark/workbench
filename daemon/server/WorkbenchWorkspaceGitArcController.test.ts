/*
 * Exports:
 * - No production exports; tests protect workspace Git arc routing, projection, and rollback.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import type WorkbenchGitCheckpointController from "./lib/workbench/git/WorkbenchGitCheckpointController";
import { WorkbenchGitArcLifecycleStateSchema, WorkbenchGitArcPlanStateSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import { renderGitArcOutput } from "./lib/workbench/cli/git-arc-output";
import WorkbenchWorkspaceGitArcController from "./WorkbenchWorkspaceGitArcController";
import type { WorkbenchGitClaimSnapshot } from "./stats/git-claim-observation";
import { applyGitClaimChanges, type GitArcClaimChanges } from "workbench-shared/workbench/git/git-arc-state";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { GitArcStatusSchema } from "workbench-shared/workbench/git/git-arc-status";
import { GitArcScopeClaimsResponseSchema } from "workbench-shared/workbench/git/git-arc-scope-response";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import OpenCodeToolsController from "./providers/opencode/OpenCodeToolsController";

const execFileAsync = promisify(execFile);

test("workspace status qualifies recovery facts and keeps roots with no lifecycle", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const calls: string[] = [];
  const controller = new WorkbenchWorkspaceGitArcController({
    ...local,
    async readStatus(input: { cwd: string }) {
      calls.push(input.cwd);
      return {
        pending: [], accepted: [], dirtyClaims: ["one.ts"], cleanClaims: [], stashedClaims: [], unclaimedDirt: ["loose.ts"],
        recovery: [{ paths: ["old.ts"], headMovement: "same", commits: [], omittedCommits: 0,
          comparison: [{ path: "old.ts", additions: 1, deletions: 0, kind: "update", binary: false }] }],
        unavailableRecovery: [],
      };
    },
  } as unknown as WorkbenchGitCheckpointController, new WorkbenchThreadTransitionCoordinator(), async root => root);
  const result = GitArcStatusSchema.parse(await controller.execute(project, {
    action: "arcStatus", cwd: project.cwd, harness: "codex", threadId: "thread-one", full: [],
  }));
  assert.equal(calls.length, 2);
  assert.deepEqual(result.dirtyClaims, ["api:one.ts", "web:one.ts"]);
  assert.deepEqual(result.unclaimedDirt, ["api:loose.ts", "web:loose.ts"]);
  assert.deepEqual(result.recovery.flatMap(value => value.comparison.map(change => change.path)), ["api:old.ts", "web:old.ts"]);
});

test("proposal lookup never mistakes unexpected missing-data errors for an absent proposal", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const controller = new WorkbenchWorkspaceGitArcController(local as unknown as WorkbenchGitCheckpointController, new WorkbenchThreadTransitionCoordinator(), async (root) => root);
  const failure = new Error("proposal metadata missing");
  let reads = 0;
  local.getProposal = async () => { reads += 1; throw failure; };
  await assert.rejects(controller.execute(project, {
    action: "proposalState", cwd: project.cwd, harness: "codex", threadId: "thread-one", proposalId: "proposal-one", includeNewer: false,
  }), (error) => error === failure);
  assert.equal(reads, 1);
});

test("inherited scope revisions retain unmentioned repositories and qualify exact removals", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const controller = new WorkbenchWorkspaceGitArcController(local as unknown as WorkbenchGitCheckpointController, new WorkbenchThreadTransitionCoordinator(), async (root) => root);
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "thread-one" };
  await controller.execute(project, {
    ...identity, action: "planClaims", inherit: false, start: false, intentName: "shared change",
    addPaths: [], removePaths: [], adoptPaths: [],
    roots: [
      { rootId: "api", addPaths: ["old.ts"], removePaths: [], adoptPaths: [] },
      { rootId: "web", addPaths: ["kept.ts"], removePaths: [], adoptPaths: [] },
    ],
  });
  await controller.execute(project, {
    ...identity, action: "planClaims", inherit: true, start: false,
    addPaths: ["api:new.ts"], removePaths: ["api:old.ts"], adoptPaths: [], roots: [],
  });
  const scope = await controller.execute(project, { ...identity, action: "arcScope" }) as { plannedPaths: string[]; claimedPaths: string[] };
  assert.deepEqual([...scope.plannedPaths].sort(), ["api:new.ts", "web:kept.ts"]);
  assert.deepEqual(scope.claimedPaths, []);
  assert.deepEqual((scope as { repositoryScopes?: Array<{ repoRoot: string; claimedPaths: string[] }> }).repositoryScopes?.map(
    entry => ({ ...entry, repoRoot: path.resolve(entry.repoRoot) }),
  ), [
    { repoRoot: path.resolve("C:/repo/api"), claimedPaths: [] },
    { repoRoot: path.resolve("C:/repo/web"), claimedPaths: [] },
  ]);
  assert.deepEqual(local.snapshotCalls, []);
  assert.deepEqual(local.claimEditCalls.at(-2)?.removePaths, [path.resolve("C:/repo/api/old.ts")]);
  await Promise.all(project.project.roots.map(root => local.startArc({ cwd: root.root })));
  const active = GitArcScopeClaimsResponseSchema.parse(await controller.execute(project, { ...identity, action: "arcScope" }));
  assert.deepEqual(active.map(entry => ({ ...entry, repoRoot: path.resolve(entry.repoRoot) })), [
    { repoRoot: path.resolve("C:/repo/api"), claimedPaths: ["new.ts"] },
    { repoRoot: path.resolve("C:/repo/web"), claimedPaths: ["kept.ts"] },
  ]);
  assert.deepEqual(local.snapshotCalls, []);
});

class FakeLocalGitArcController {
  readonly claimEditCalls: Array<GitArcClaimChanges & { cwd: string }> = [];
  readonly blockedRoots = new Set<string>();
  readonly claimPresenceCalls: string[] = [];
  readonly collisionCalls: Array<{ checkpointCommit?: string; cwd: string }> = [];
  readonly compareCalls: Array<{ cwd: string; ref?: string }> = [];
  readonly compareSnapshots: object[] = [];
  readonly dirtyRoots = new Set<string>();
  readonly dirtSnapshots: object[] = [];
  readonly diffContents = new Map<string, string>();
  readonly unclaimedDirt = new Map<string, string[]>();
  readonly lifecycleFindCalls: string[] = [];
  readonly lifecycleListCalls: string[] = [];
  readonly proposalDetailCalls: string[] = [];
  readonly proposalPathCalls: string[] = [];
  readonly snapshotCalls: string[] = [];
  readonly stashFailureRoots = new Set<string>();
  readonly unstashFailureRoots = new Set<string>();
  readonly stashCalls: string[] = [];
  readonly unstashCalls: string[] = [];
  readonly restashCalls: string[] = [];
  readonly startCalls: string[] = [];
  private nextProposal = 0;
  private readonly plans = new Map<string, { checkpointCommit: string; harness: string; intentDescription: string; intentName: string; scopePaths: string[]; threadId: string; updatedAt: string }>();
  private readonly proposals = new Map<string, { cwd: string; paths: string[]; proposalId: string }>();
  private readonly states = new Map<string, {
    checkpointCommit: string; claimedPaths: string[]; harness: string; intentDescription: string; intentName: string;
    phase: "active" | "stashed"; proposals: Array<{ proposalId: string; status: "proposed" }>; stashedPaths?: string[];
    threadId: string; updatedAt: string; pendingPlan?: boolean;
  }>();

  markPendingPlan(root: string) {
    const state = this.states.get(root);
    if (!state) throw new Error("Missing fake arc.");
    this.states.set(root, { ...state, pendingPlan: true });
  }

  async readScope(input: { cwd: string }) {
    const active = this.states.get(input.cwd);
    const plan = this.plans.get(input.cwd);
    if (!active && !plan) return null;
    return {
      checkpointCommit: (active ?? plan)!.checkpointCommit,
      intentName: (active ?? plan)!.intentName,
      phase: active?.phase === "stashed" ? "stashed" as const
        : active ? active.pendingPlan ? "plan" as const : "active" as const : "plan" as const,
      claimedPaths: active?.claimedPaths ?? [], plannedPaths: active ? [] : plan!.scopePaths,
      adoptedPaths: [], repoRoot: input.cwd,
    };
  }

  async editPlanClaims(input: GitArcClaimChanges & { cwd: string; harness: string; threadId: string; intentName?: string; start?: boolean }) {
    this.claimEditCalls.push(input);
    const current = await this.readScope(input);
    const normalize = (values: string[] | undefined) => (values ?? []).map((value) => path.relative(input.cwd, value).replace(/\\/gu, "/"));
    const final = applyGitClaimChanges(current?.plannedPaths ?? [], {
      ...input, addPaths: normalize(input.addPaths), removePaths: normalize(input.removePaths), adoptPaths: normalize(input.adoptPaths),
    });
    const result = await this.createPlan({
      ...input, intentDescription: "", intentName: input.intentName ?? current?.intentName ?? "",
      paths: final.map((value) => path.join(input.cwd, value)),
    });
    return input.start ? await this.startArc(input) : result;
  }

  async createPlan(input: { cwd: string; harness: string; intentDescription: string; intentName: string; paths: string[]; threadId: string }) {
    const relativePaths = input.paths.map((filePath) => path.relative(input.cwd, filePath).replace(/\\/gu, "/")).sort();
    const skippedIgnoredPaths = relativePaths.filter((filePath) => filePath.startsWith("ignored/"));
    const scopePaths = relativePaths.filter((filePath) => !filePath.startsWith("ignored/"));
    if (!scopePaths.length && skippedIgnoredPaths.length) {
      return { kind: "noop", noOp: true, repoRoot: input.cwd, scopePaths, skippedIgnoredPaths };
    }
    const checkpointCommit = input.cwd.toLowerCase().includes("fixture-copy")
      ? `${String(this.plans.size + 1).repeat(40).slice(0, 40)}`
      : "a".repeat(40);
    this.plans.set(input.cwd, {
      checkpointCommit, harness: input.harness, intentDescription: input.intentDescription, intentName: input.intentName,
      scopePaths, threadId: input.threadId, updatedAt: "2026-08-24T00:00:00.000Z",
    });
    return {
      checkpointCommit, checkpointRef: `refs/${checkpointCommit}`, intentName: input.intentName, kind: "plan",
      repoRoot: input.cwd, scopePaths, skippedIgnoredPaths,
    };
  }

  async startArc(input: { cwd: string }) {
    this.startCalls.push(input.cwd);
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

  async createInspectionSnapshot(cwd: string) {
    this.snapshotCalls.push(cwd);
    return { cwd };
  }

  async compare(input: { cwd: string; ref?: string }, snapshot?: object) {
    this.compareCalls.push(input);
    if (snapshot) this.compareSnapshots.push(snapshot);
    const state = this.states.get(input.cwd)!;
    const proposal = input.ref ? this.proposals.get(input.ref) : null;
    const scopePaths = proposal?.paths ?? state.claimedPaths;
    return {
      changes: scopePaths.map((filePath) => ({
        additions: 1,
        deletions: 0,
        diff: this.diffContents.get(`${input.cwd}:${filePath}`) ?? `diff --git a/${filePath} b/${filePath}\n`,
        kind: { move_path: null, type: "update" },
        path: filePath,
      })),
      checkpointCommit: state.checkpointCommit, checkpointRef: `refs/${state.checkpointCommit}`,
      hasUncommittedChanges: this.dirtyRoots.has(input.cwd), intentName: state.intentName,
      ...(proposal ? { proposalId: proposal.proposalId } : {}),
      repoRoot: input.cwd, scopePaths,
    };
  }

  async listUnclaimedWorkspaceDirt(input: { cwd: string }, snapshot?: object) {
    if (snapshot) this.dirtSnapshots.push(snapshot);
    return this.unclaimedDirt.get(input.cwd) ?? [];
  }

  async findLifecycleState(input: { cwd: string; harness: string; threadId: string }) {
    this.lifecycleFindCalls.push(input.cwd);
    const state = this.states.get(input.cwd);
    return state?.harness === input.harness && state.threadId === input.threadId ? state : null;
  }

  async hasLiveClaimsAtRepoRoot(input: { cwd: string; harness: string; threadId: string }) {
    this.claimPresenceCalls.push(input.cwd);
    const state = this.states.get(input.cwd);
    return Boolean(
      state
      && state.harness === input.harness
      && state.threadId === input.threadId
      && state.claimedPaths.length,
    );
  }

  async assertArcReleasable(input: { cwd: string }) {
    if (!this.states.has(input.cwd)) throw new Error("This thread does not own any live Git arc claims.");
  }

  async assertArcStashable(input: { cwd: string }) {
    if (this.states.get(input.cwd)?.phase !== "active") throw new Error("This thread does not own an active Git arc.");
  }

  async assertArcUnstashable(input: { cwd: string }) {
    if (this.states.get(input.cwd)?.phase !== "stashed") throw new Error("This thread does not own a stashed Git arc.");
  }

  async stashArc(input: { cwd: string }) {
    this.stashCalls.push(input.cwd);
    if (this.stashFailureRoots.has(input.cwd)) throw new Error("stash failed");
    const state = this.states.get(input.cwd)!;
    const stashedPaths = [...state.claimedPaths];
    this.states.set(input.cwd, { ...state, claimedPaths: [], phase: "stashed", stashedPaths });
    return {
      checkpointCommit: state.checkpointCommit, checkpointRef: `refs/${state.checkpointCommit}`,
      conflictedPaths: [], intentName: state.intentName, kind: "arc", phase: "stashed" as const,
      repoRoot: input.cwd, scopePaths: [], stashedPaths,
    };
  }

  async unstashArc(input: { cwd: string }) {
    this.unstashCalls.push(input.cwd);
    if (this.unstashFailureRoots.has(input.cwd)) throw new Error("unstash failed");
    const state = this.states.get(input.cwd)!;
    const claimedPaths = [...(state.stashedPaths ?? [])];
    this.states.set(input.cwd, { ...state, claimedPaths, phase: "active", stashedPaths: undefined });
    return {
      checkpointCommit: state.checkpointCommit, checkpointRef: `refs/${state.checkpointCommit}`,
      conflictedPaths: [], intentName: state.intentName, kind: state.pendingPlan ? "plan" as const : "arc" as const, phase: "active" as const,
      repoRoot: input.cwd, scopePaths: claimedPaths, stashedPaths: [],
    };
  }

  async restashArc(input: { cwd: string }) {
    this.restashCalls.push(input.cwd);
    const state = this.states.get(input.cwd)!;
    const stashedPaths = [...state.claimedPaths];
    this.states.set(input.cwd, { ...state, claimedPaths: [], phase: "stashed", stashedPaths });
    return {
      checkpointCommit: state.checkpointCommit, checkpointRef: `refs/${state.checkpointCommit}`,
      conflictedPaths: [], intentName: state.intentName, kind: "arc", phase: "stashed" as const,
      repoRoot: input.cwd, scopePaths: [], stashedPaths,
    };
  }

  async releaseArc(input: { cwd: string; disown: boolean }) {
    const state = this.states.get(input.cwd);
    if (!state) throw new Error("This thread does not own any live Git arc claims.");
    const retainedClaims = input.disown || !this.dirtyRoots.has(input.cwd) ? [] : state.claimedPaths;
    const releasedClaims = state.claimedPaths.filter(path => !retainedClaims.includes(path));
    if (retainedClaims.length) this.states.set(input.cwd, { ...state, claimedPaths: retainedClaims });
    else this.states.delete(input.cwd);
    return {
      checkpointCommit: state.checkpointCommit,
      checkpointRef: `refs/${state.checkpointCommit}`,
      intentName: state.intentName,
      kind: "arc",
      phase: retainedClaims.length ? "active" : "resolved",
      releasedClaims,
      repoRoot: input.cwd,
      scopePaths: retainedClaims,
      ...(releasedClaims.length ? {} : { unchanged: true }),
    };
  }

  async listLifecycleStates(input: { cwd: string }) {
    this.lifecycleListCalls.push(input.cwd);
    return this.states.has(input.cwd) ? [this.states.get(input.cwd)!] : [];
  }
  async findPlanState(input: { cwd: string }) { return this.plans.get(input.cwd) ?? null; }
  async listPlanStates(input: { cwd: string }) { return this.plans.has(input.cwd) ? [this.plans.get(input.cwd)!] : []; }
  async findPlanClaimCollisions(input: { checkpointCommit?: string; cwd: string }) {
    this.collisionCalls.push({ checkpointCommit: input.checkpointCommit, cwd: input.cwd });
    const plan = this.plans.get(input.cwd)!;
    return {
      checkpointCommit: input.checkpointCommit ?? plan.checkpointCommit,
      collisions: this.blockedRoots.has(input.cwd) ? [{
        entry: {
          checkpointCommit: "f".repeat(40), claimedPaths: plan.scopePaths, harness: "opencode",
          intentDescription: "", intentName: "Blocking arc", threadId: "blocking-thread",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
        overlaps: [{ claimedPath: plan.scopePaths[0]!, requestedPath: plan.scopePaths[0]! }],
      }] : [],
      repoRoot: input.cwd,
      scopePaths: plan.scopePaths,
    };
  }

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
    this.proposalDetailCalls.push(input.proposalId);
    return this.getStoredProposal(input);
  }

  async getProposalPaths(input: { cwd: string; proposalId: string }) {
    this.proposalPathCalls.push(input.proposalId);
    return this.getStoredProposal(input).paths;
  }

  private getStoredProposal(input: { cwd: string; proposalId: string }) {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.cwd !== input.cwd) throw new GitArcRejectionError({ reason: "proposalNotFound", proposalId: input.proposalId });
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
    project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("workspace"), kind: "workspace", root: primary, rootPath: primary, roots },
    root: roots[0]!,
  };
}

test("workspace claim waits resolve current and explicit refs for every inactive plan member", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "thread-one" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "Wait plan",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["src/api.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["src/web.ts"], rootId: "web" },
    ],
    ...identity,
  }) as { members: Array<{ checkpointCommit: string; rootId: string }> };
  const current = await controller.findPlanClaimCollisions(project, {
    action: "arcWait", refs: [], ...identity,
  });
  assert.deepEqual(current.members.map(({ rootId, scopePaths }) => ({ rootId, scopePaths })), [
    { rootId: "api", scopePaths: ["api:src/api.ts"] },
    { rootId: "web", scopePaths: ["web:src/web.ts"] },
  ]);
  local.collisionCalls.length = 0;
  await controller.findPlanClaimCollisions(project, {
    action: "arcWait",
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  });
  assert.deepEqual(local.collisionCalls.map(({ checkpointCommit, cwd }) => ({
    checkpointCommit,
    cwd,
  })), [
    { checkpointCommit: plan.members[0]!.checkpointCommit, cwd: "C:/repo/api" },
    { checkpointCommit: plan.members[1]!.checkpointCommit, cwd: "C:/repo/web" },
  ]);
});

test("workspace wait start changes zero members when any planned repository is claimed", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "thread-one" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "Wait plan",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["src/api.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["src/web.ts"], rootId: "web" },
    ],
    ...identity,
  }) as { members: Array<{ checkpointCommit: string; rootId: string }> };
  const request = {
    action: "arcWait" as const,
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  };
  let starts = 0;
  local.blockedRoots.add("C:/repo/web");
  const blocked = await controller.tryStartWaitingArc(project, request, {
    beforeStart: () => { starts += 1; },
    throwIfAborted: () => undefined,
  });
  assert.equal(blocked.kind, "blocked");
  assert.equal(starts, 0);
  assert.deepEqual(local.startCalls, []);

  local.blockedRoots.clear();
  const started = await controller.tryStartWaitingArc(project, request, {
    beforeStart: () => { starts += 1; },
    throwIfAborted: () => undefined,
  });
  assert.equal(started.kind, "started");
  assert.equal(starts, 1);
  assert.deepEqual(new Set(local.startCalls), new Set(["C:/repo/api", "C:/repo/web"]));
});

test("active claims and Git ignore rules cover patch paths across workspace roots", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-claim-coverage-"));
  context.after(async () => await rm(temporaryRoot, { force: true, recursive: true }));
  const apiRoot = path.join(temporaryRoot, "api");
  const webRoot = path.join(temporaryRoot, "web");
  const apiSource = path.join(apiRoot, "src");
  await mkdir(apiSource, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await Promise.all([
    execFileAsync("git", ["init"], { cwd: apiRoot }),
    execFileAsync("git", ["init"], { cwd: webRoot }),
  ]);
  await writeFile(path.join(apiSource, "nested.ts"), "export {};\n", "utf8");
  await writeFile(path.join(webRoot, "claimed.ts"), "export {};\n", "utf8");
  const trackedIgnored = path.join(apiRoot, "tracked.log");
  await writeFile(trackedIgnored, "tracked\n", "utf8");
  await execFileAsync("git", ["add", "tracked.log"], { cwd: apiRoot });
  await writeFile(path.join(apiRoot, ".gitignore"), "ignored/\n*.log\n", "utf8");
  const project = createWorkspace(apiRoot, webRoot);
  const controller = new WorkbenchWorkspaceGitArcController(
    new FakeLocalGitArcController() as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: apiRoot, harness: "opencode" as const, threadId: "claim-thread" };
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
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, identity.threadId, covered), {
    allowed: true,
    uncoveredPaths: [],
  });
  if (process.platform === "win32") {
    assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, identity.threadId, covered.map((filePath) => filePath.toLowerCase())), {
      allowed: true,
      uncoveredPaths: [],
    });
  }
  const uncovered = [path.join(apiRoot, "sibling.ts"), path.join(webRoot, "destination.ts"), path.join(temporaryRoot, "outside.ts")];
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, identity.threadId, uncovered), {
    allowed: false,
    uncoveredPaths: uncovered,
  });
  const ignored = [path.join(apiRoot, "ignored", "generated.ts"), path.join(apiRoot, "untracked.log")];
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, identity.threadId, [...covered, ...ignored]), {
    allowed: true,
    uncoveredPaths: [],
  });
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, identity.threadId, [...ignored, trackedIgnored]), {
    allowed: false,
    uncoveredPaths: [trackedIgnored],
  });
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, "no-active-arc", ignored), {
    allowed: true,
    uncoveredPaths: [],
  });
  assert.deepEqual(await controller.checkActiveClaimPaths(project, identity.harness, "no-active-arc", covered), {
    allowed: false,
    uncoveredPaths: covered,
  });

  const native = new OpenCodeToolsController({
    resolveCaller: async () => ({
      cwd: apiRoot, harness: "opencode",
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId),
    }),
    execute: async () => { throw new Error("must not execute"); },
  });
  const admit = async (resources: string[]) => JSON.parse(await native.patchClaims({
    callerThreadId: null, raw: JSON.stringify({ sessionID: "native", resources }),
  }, caller => controller.checkActiveClaimPaths(project, caller.harness, caller.threadId, caller.paths), new AbortController().signal));
  assert.deepEqual(await admit([
    "src/nested.ts", "src/new.ts", "future.ts", "../web/claimed.ts", covered[0]!,
  ]), { allowed: true });
  for (const resource of ["sibling.ts", "../web/destination.ts", "../outside.ts", uncovered[2]!]) {
    assert.equal((await admit(["src/nested.ts", resource])).allowed, false);
  }
  assert.deepEqual(await admit(["ignored/generated.ts", "untracked.log"]), { allowed: true });
  assert.equal((await admit(["tracked.log"])).allowed, false);
});

test("workspace arc results qualify ignored skips and become no-ops only when every member skips", async () => {
  const apiRoot = "C:/workspace/api";
  const webRoot = "C:/workspace/web";
  const project = createWorkspace(apiRoot, webRoot);
  const controller = new WorkbenchWorkspaceGitArcController(
    new FakeLocalGitArcController() as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: apiRoot, harness: "codex" as const, threadId: "ignored-plan-thread" };

  const mixed = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "mixed ignored plan",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["ignored/generated.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["src/valid.ts"], rootId: "web" },
    ],
    ...identity,
  }) as Record<string, unknown>;
  assert.equal(mixed.noOp, false);
  assert.deepEqual(mixed.scopePaths, ["web:src/valid.ts"]);
  assert.deepEqual(mixed.skippedIgnoredPaths, ["api:ignored/generated.ts"]);
  assert.equal(typeof mixed.checkpointCommit, "string");

  const skipped = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "ignored-only plan",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["ignored/api.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["ignored/web.ts"], rootId: "web" },
    ],
    ...identity,
  }) as Record<string, unknown>;
  assert.equal(skipped.noOp, true);
  assert.deepEqual(skipped.scopePaths, []);
  assert.deepEqual(skipped.skippedIgnoredPaths, ["api:ignored/api.ts", "web:ignored/web.ts"]);
  assert.equal(skipped.checkpointCommit, undefined);
});

test("one workspace arc aggregates two repositories and keeps proposals root-specific", async () => {
  const apiRoot = "C:/workspace/api";
  const webRoot = "C:/workspace/web";
  const project = createWorkspace(apiRoot, webRoot);
  const local = new FakeLocalGitArcController();
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
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
  const lifecycleReadsBeforeClaims = local.lifecycleFindCalls.length + local.lifecycleListCalls.length;
  assert.equal(await controller.hasLiveClaims(project, "codex", identity.threadId), true);
  assert.deepEqual(local.claimPresenceCalls, [apiRoot, webRoot]);
  assert.equal(local.lifecycleFindCalls.length + local.lifecycleListCalls.length, lifecycleReadsBeforeClaims);

  const comparison = await controller.execute(project, {
    action: "compare", refs: [], roots: [], ...identity,
  }, { modifiedSince: 1 }) as { changes: Array<{ path: string }>; hasUncommittedChanges: boolean };
  assert.deepEqual(comparison.changes.map(({ path: filePath }) => filePath), ["api:one.txt", "web:two.txt"]);
  assert.equal(comparison.hasUncommittedChanges, false);
  local.dirtyRoots.add(webRoot);
  const dirtyComparison = await controller.execute(project, {
    action: "compare", refs: [], roots: [], ...identity,
  }, { modifiedSince: 1 }) as { hasUncommittedChanges: boolean };
  assert.equal(dirtyComparison.hasUncommittedChanges, true);
  local.dirtyRoots.delete(webRoot);

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
  const compareCallCount = local.compareCalls.length;
  await controller.execute(project, {
    action: "compare",
    refs: [
      { ref: apiProposal.proposalId, rootId: "api" },
      { ref: webProposal.proposalId, rootId: "web" },
    ],
    roots: [],
    ...identity,
  }, { modifiedSince: 1 });
  assert.deepEqual(local.compareCalls.slice(compareCallCount), [
    { cwd: apiRoot, harness: "codex", ref: apiProposal.proposalId, threadId: identity.threadId },
    { cwd: webRoot, harness: "codex", ref: webProposal.proposalId, threadId: identity.threadId },
  ]);
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
  const contentAmendment = await controller.execute(project, {
    action: "proposalCreate", amend: true, amendProposalId: webProposal.proposalId,
    description: "Content amendment", freshDescription: "Keep web history intact",
    freshTitle: "Add web content", title: "Amend web content", ...identity,
  }) as { paths: string[]; proposalId: string; receivedPaths?: string[]; rootId: string };
  assert.deepEqual({
    paths: contentAmendment.paths,
    receivedPaths: contentAmendment.receivedPaths,
    rootId: contentAmendment.rootId,
  }, {
    paths: ["two.txt"],
    receivedPaths: ["two.txt"],
    rootId: "web",
  });

  const findCallsBefore = local.lifecycleFindCalls.length;
  const listCallsBefore = local.lifecycleListCalls.length;
  const proposalDetailCallsBefore = local.proposalDetailCalls.length;
  const proposalPathCallsBefore = local.proposalPathCalls.length;
  const lifecycle = await controller.findLifecycleState(project, "codex", identity.threadId);
  assert.deepEqual(local.lifecycleFindCalls.slice(findCallsBefore).sort(), [apiRoot, webRoot].sort());
  assert.equal(local.lifecycleListCalls.length, listCallsBefore);
  assert.equal(local.proposalDetailCalls.length, proposalDetailCallsBefore);
  assert.deepEqual(local.proposalPathCalls.slice(proposalPathCallsBefore), [
    apiProposal.proposalId,
    webProposal.proposalId,
    messageAmendment.proposalId,
    contentAmendment.proposalId,
  ]);
  assert.ok(lifecycle);
  const { harness: _arcHarness, threadId: _arcThreadId, ...sidebarLifecycle } = lifecycle;
  assert.deepEqual(WorkbenchGitArcLifecycleStateSchema.parse(sidebarLifecycle).claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.claimedPaths, ["api:one.txt", "web:two.txt"]);
  assert.deepEqual(lifecycle?.proposals.map(({ proposalId, rootId }) => ({ proposalId, rootId })), [
    { proposalId: apiProposal.proposalId, rootId: "api" },
    { proposalId: webProposal.proposalId, rootId: "web" },
    { proposalId: messageAmendment.proposalId, rootId: "web" },
    { proposalId: contentAmendment.proposalId, rootId: "web" },
  ]);

  local.dirtyRoots.add(webRoot);
  const partial = await controller.execute(project, {
    action: "arcRelease", disown: false, ...identity,
  }) as { releasedClaims: string[]; scopePaths: string[] };
  assert.deepEqual(partial.releasedClaims, ["api:one.txt"]);
  assert.deepEqual(partial.scopePaths, ["web:two.txt"]);
  assert.deepEqual((await controller.findLifecycleState(project, "codex", identity.threadId))?.claimedPaths, ["web:two.txt"]);
  const released = await controller.execute(project, {
    action: "arcRelease", disown: true, ...identity,
  }) as { releasedClaims: string[] };
  assert.deepEqual(released.releasedClaims, ["web:two.txt"]);
  assert.equal(await controller.findLifecycleState(project, "codex", identity.threadId), null);
  assert.equal(await controller.hasLiveClaims(project, "codex", identity.threadId), false);
});

test("workspace diff uses one packed page budget and reports dirt from every repository", async () => {
  const apiRoot = "C:/workspace/api";
  const webRoot = "C:/workspace/web";
  const project = createWorkspace(apiRoot, webRoot);
  const local = new FakeLocalGitArcController();
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
  );
  const identity = { cwd: apiRoot, harness: "codex" as const, threadId: "paged-thread" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "Page workspace diff",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["a.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["b.ts", "c.ts"], rootId: "web" },
    ],
    ...identity,
  }) as unknown as { members: Array<{ checkpointCommit: string; rootId: string }> };
  await controller.execute(project, {
    action: "arcStart",
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  });

  local.diffContents.set(`${apiRoot}:a.ts`, "a".repeat(8_000));
  local.diffContents.set(`${webRoot}:b.ts`, "b".repeat(8_000));
  local.diffContents.set(`${webRoot}:c.ts`, "c".repeat(6_000));
  local.unclaimedDirt.set(apiRoot, ["loose-api.ts"]);
  local.unclaimedDirt.set(webRoot, ["loose-web.ts"]);

  const first = await controller.execute(project, {
    action: "diff", refs: [], roots: [], ...identity,
  }, { modifiedSince: 100 }) as {
    changes: Array<{ path: string }>;
    diff: string;
    nextPage: number | null;
    unclaimedDirtPaths: string[];
  };
  const second = await controller.execute(project, {
    action: "diff", page: 2, refs: [], roots: [], ...identity,
  }, { modifiedSince: 100 }) as {
    changes: Array<{ path: string }>;
    diff: string;
    nextPage: number | null;
  };

  assert.deepEqual(first.changes.map(({ path: filePath }) => filePath), ["api:a.ts", "web:c.ts"]);
  assert.deepEqual(second.changes.map(({ path: filePath }) => filePath), ["web:b.ts"]);
  assert.equal(first.nextPage, 2);
  assert.equal(second.nextPage, null);
  assert.deepEqual(first.unclaimedDirtPaths, ["api:loose-api.ts", "web:loose-web.ts"]);
  assert.equal(local.snapshotCalls.length, 4);
  assert.equal(local.compareSnapshots.length, 4);
  assert.equal(local.dirtSnapshots.length, 4);
  assert(local.compareSnapshots.every((snapshot) => local.dirtSnapshots.includes(snapshot)));
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

test("workspace mutations expand directory claims to their contained files", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/workspace/api", "C:/workspace/web");
  const snapshots: WorkbenchGitClaimSnapshot[] = [];
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
    (snapshot) => snapshots.push(snapshot),
    {
      expandScopes: async ({ scopePaths }) => scopePaths.flatMap((scope) => (
        scope === "src" ? ["src/one.ts", "src/two.ts"] : ["packages/ui/Button.tsx"]
      )),
    },
  );
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "claim-thread" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "observe claims",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["src"], rootId: "api" },
      { adoptPaths: [], paths: ["packages/ui"], rootId: "web" },
    ],
    ...identity,
  }) as { members: Array<{ checkpointCommit: string; rootId: string }> };
  await controller.execute(project, {
    action: "arcStart",
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  });
  assert.deepEqual(snapshots.slice(-2).map(({ roots }) => roots), [
    [{ paths: ["src/one.ts", "src/two.ts"], rootId: "api" }],
    [{ paths: ["packages/ui/Button.tsx"], rootId: "web" }],
  ]);
  await controller.execute(project, { action: "arcRelease", disown: true, ...identity });
  assert.deepEqual(snapshots.slice(-2).map(({ roots }) => roots), [
    [{ paths: [], rootId: "api" }],
    [{ paths: [], rootId: "web" }],
  ]);
});

test("workspace partial mutation failure still observes every member's post-failure claim truth", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/workspace/api", "C:/workspace/web");
  const snapshots: WorkbenchGitClaimSnapshot[] = [];
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async (rootPath) => rootPath,
    (snapshot) => snapshots.push(snapshot),
    { expandScopes: async ({ scopePaths }) => scopePaths },
  );
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "partial-thread" };
  const plan = await controller.execute(project, {
    action: "plan",
    adoptPaths: [],
    intentDescription: "",
    intentName: "partial claims",
    paths: [],
    roots: [
      { adoptPaths: [], paths: ["src/api.ts"], rootId: "api" },
      { adoptPaths: [], paths: ["src/web.ts"], rootId: "web" },
    ],
    ...identity,
  }) as { members: Array<{ checkpointCommit: string; rootId: string }> };
  const start = local.startArc.bind(local);
  local.startArc = async (input: { cwd: string }) => {
    if (input.cwd === "C:/workspace/web") throw new GitArcRejectionError({ reason: "emptyPlan" }, "web start failed");
    return await start(input);
  };
  snapshots.length = 0;
  await assert.rejects(controller.execute(project, {
    action: "arcStart",
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
    ...identity,
  }), (error: Error) => {
    assert.ok("workspace" in error);
    assert.deepEqual(error.workspace, { failedRootIds: ["web"], completedRootIds: ["api"], stage: "operation" });
    assert.ok(error.cause instanceof GitArcRejectionError);
    assert.deepEqual(error.cause.rejection, { reason: "emptyPlan" });
    return true;
  });
  assert.deepEqual(snapshots.map(({ roots }) => roots), [
    [{ paths: ["src/api.ts"], rootId: "api" }],
    [{ paths: [], rootId: "web" }],
  ]);
});

test("workspace stash and unstash compensate completed members when a later repository fails", async () => {
  const local = new FakeLocalGitArcController();
  const project = createWorkspace("C:/repo/api", "C:/repo/web");
  const controller = new WorkbenchWorkspaceGitArcController(
    local as unknown as WorkbenchGitCheckpointController,
    new WorkbenchThreadTransitionCoordinator(),
    async root => root,
  );
  const identity = { cwd: project.cwd, harness: "codex" as const, threadId: "thread-stash" };
  const plan = await controller.execute(project, {
    ...identity,
    action: "planClaims",
    addPaths: [],
    adoptPaths: [],
    inherit: false,
    intentName: "stash together",
    removePaths: [],
    roots: [
      { rootId: "api", addPaths: ["one.ts"], adoptPaths: [], removePaths: [] },
      { rootId: "web", addPaths: ["two.ts"], adoptPaths: [], removePaths: [] },
    ],
    start: false,
  }) as { members: Array<{ checkpointCommit: string; rootId: string }> };
  await controller.execute(project, {
    ...identity,
    action: "arcStart",
    checkpointCommit: undefined,
    refs: plan.members.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })),
  });

  local.stashFailureRoots.add("C:/repo/web");
  await assert.rejects(controller.execute(project, { ...identity, action: "arcStash" }), /stash failed/u);
  assert.deepEqual(local.stashCalls.map(path.normalize), [path.resolve("C:/repo/api"), path.resolve("C:/repo/web")].map(path.normalize));
  assert.deepEqual(local.unstashCalls.map(path.normalize), [path.resolve("C:/repo/api")].map(path.normalize));
  assert.equal((await controller.findLifecycleState(project, "codex", identity.threadId))?.phase, "active");

  local.stashFailureRoots.clear();
  local.markPendingPlan("C:/repo/api");
  await controller.execute(project, { ...identity, action: "arcStash" });
  local.unstashCalls.length = 0;
  local.unstashFailureRoots.add("C:/repo/web");
  await assert.rejects(controller.execute(project, { ...identity, action: "arcUnstash" }), /unstash failed/u);
  assert.deepEqual(local.restashCalls.map(path.normalize), [path.resolve("C:/repo/api")].map(path.normalize));
  assert.equal((await controller.findLifecycleState(project, "codex", identity.threadId))?.phase, "stashed");
  assert.equal((await controller.execute(project, { ...identity, action: "arcScope" }) as { members: Array<{ phase: string }> }).members[0]?.phase, "stashed");
  local.unstashFailureRoots.clear();
  const restored = await controller.execute(project, { ...identity, action: "arcUnstash" });
  assert.match(renderGitArcOutput({
    method: "POST", path: "/api/git/arc/unstash", responseKind: "git-arc-unstash",
  }, restored as Record<string, unknown>), /^arc unstash plan$/mu);
  assert.equal((await controller.execute(project, { ...identity, action: "arcScope" }) as { members: Array<{ phase: string }> }).members[0]?.phase, "plan");
});
