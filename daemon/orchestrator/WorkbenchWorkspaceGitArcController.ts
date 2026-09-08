/*
 * Keywords: git, workspace, roots, scope, partial outcomes, inspection.
 * Exports:
 * - WorkspaceGitArcMemberError: preserve failed/completed member facts around the original failure.
 * - default WorkbenchWorkspaceGitArcController: aggregate repo-local Git arc members, globally page inspection diffs, report workspace dirt, route proposal-owned amendments, and prune thread history. Keywords: git, arc, workspace, multi-root, diff, dirt, proposal, retention.
 * - WorkspaceGitArcMemberState: active repo-local member plus root identity. Keywords: git, arc, active, member.
 * - WorkspaceGitArcLifecycleState: active logical workspace projection. Keywords: git, arc, lifecycle, projection.
 * - WorkspaceGitArcPlanMemberState: planned repo-local member plus root identity. Keywords: git, arc, plan, member.
 * - WorkspaceGitArcPlanState: inactive logical workspace projection. Keywords: git, arc, plan, projection.
 * - WorkspaceGitArcPlanClaimCollisionResult: project-qualified inactive member collision results.
 * Local mechanics: emit WorkbenchGitClaimSnapshot after mutations while the owning Git transition remains held. Keywords: git, claims, stats.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";

import type { ResolvedProjectRoot } from "../lib/project";
import type { WorkbenchHarness } from "workbench-shared/types";
import type {
  GitArcRootPaths,
  GitCheckpointFileChange,
  GitCheckpointRequest,
} from "workbench-shared/workbench/git/checkpoint-contracts";
import { createGitArcDiffPage } from "workbench-shared/workbench/git/git-arc-diff-pages";
import WorkbenchGitCheckpointController, {
  type GitArcLifecycleState,
  type GitArcPlanClaimCollisionResult,
  type GitArcPlanState,
  type GitArcRetentionResult,
} from "../lib/workbench/git/WorkbenchGitCheckpointController";
import GitClaimHistoryReader from "../lib/workbench/git/GitClaimHistoryReader";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { WorkbenchGitClaimSnapshot } from "./stats/git-claim-observation";

export class WorkspaceGitArcMemberError extends Error {
  constructor(readonly workspace: NonNullable<GitArcFailure["workspace"]>, cause: unknown) {
    const stage = workspace.stage === "preflight" ? " before any member changed"
      : workspace.completedRootIds.length ? ` after completing ${workspace.completedRootIds.join(", ")}` : "";
    super(`Workspace Git arc member ${workspace.failedRootIds.join(", ")} failed${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WorkspaceGitArcMemberError";
  }
}

interface GitTransitions {
  readMany<TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>): Promise<TValue>;
  runMany<TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>): Promise<TValue>;
}

type ResolveGitRepoRoot = (rootPath: string) => Promise<string | null>;

interface RepoMember {
  repoRoot: string;
  roots: ResolvedProjectRoot[];
}

interface RootPathInput {
  adoptPaths?: string[];
  paths: string[];
  rootId: string;
}

class WorkspaceGitArcWaitBlockedError extends Error {
  constructor() {
    super("Sibling claims still intersect this workspace Git arc plan.");
    this.name = "WorkspaceGitArcWaitBlockedError";
  }
}

function findWorkspaceGitArcWaitBlockedError(error: unknown) {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof WorkspaceGitArcWaitBlockedError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

export interface WorkspaceGitArcMemberState extends GitArcLifecycleState {
  repoRoot: string;
  rootId: string;
  rootIds: string[];
  proposals: Array<GitArcLifecycleState["proposals"][number] & { rootId: string }>;
}

export interface WorkspaceGitArcLifecycleState extends GitArcLifecycleState {
  members: WorkspaceGitArcMemberState[];
  proposals: Array<GitArcLifecycleState["proposals"][number] & { rootId: string }>;
}

export interface WorkspaceGitArcPlanMemberState extends GitArcPlanState {
  repoRoot: string;
  rootId: string;
  rootIds: string[];
}

export interface WorkspaceGitArcPlanState extends GitArcPlanState {
  members: WorkspaceGitArcPlanMemberState[];
}

export interface WorkspaceGitArcPlanClaimCollisionResult extends GitArcPlanClaimCollisionResult {
  members: Array<GitArcPlanClaimCollisionResult & {
    rootId: string;
    rootIds: string[];
  }>;
}

function comparable(filePath: string) {
  const normalized = path.resolve(filePath).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(candidate: string, root: string) {
  const value = comparable(candidate);
  const boundary = comparable(root);
  return value === boundary || value.startsWith(`${boundary}/`);
}

function unique(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function identityKey(harness: string, threadId: string) {
  return `${harness.toLowerCase()}\0${threadId.toLowerCase()}`;
}

export default class WorkbenchWorkspaceGitArcController {
  constructor(
    private readonly local = new WorkbenchGitCheckpointController(),
    private readonly transitions: GitTransitions,
    private readonly resolveGitRepoRoot: ResolveGitRepoRoot = async (rootPath) => (await WorkbenchGitRepository.tryOpen(rootPath))?.root ?? null,
    private readonly observeClaimSnapshot: ((snapshot: WorkbenchGitClaimSnapshot) => void) | null = null,
    private readonly claimHistory: Pick<GitClaimHistoryReader, "expandScopes"> = new GitClaimHistoryReader(),
  ) {}

  async listLifecycleStates(project: AgentEndpointProjectResolution): Promise<WorkspaceGitArcLifecycleState[]> {
    const members = await this.resolveRepoMembers(project);
    const localStates = (await Promise.all(members.map(async (member) => (
      (await this.local.listLifecycleStates({ cwd: member.repoRoot })).map((state) => ({ member, state }))
    )))).flat();
    const groups = new Map<string, Array<{ member: RepoMember; state: GitArcLifecycleState }>>();
    for (const value of localStates) {
      const key = identityKey(value.state.harness, value.state.threadId);
      groups.set(key, [...groups.get(key) ?? [], value]);
    }
    return await Promise.all([...groups.values()].map((values) => this.aggregateLifecycle(project, values)));
  }

  async findLifecycleState(project: AgentEndpointProjectResolution, harness: WorkbenchHarness, threadId: string) {
    const members = await this.resolveRepoMembers(project);
    return await this.findLifecycleStateInMembers(project, members, harness, threadId);
  }

  async hasLiveClaims(project: AgentEndpointProjectResolution, harness: WorkbenchHarness, threadId: string) {
    const members = await this.resolveRepoMembers(project);
    const claims = await Promise.all(members.map(async (member) => (
      await this.local.hasLiveClaimsAtRepoRoot({ cwd: member.repoRoot, harness, threadId })
    )));
    return claims.some(Boolean);
  }

  private async findLifecycleStateInMembers(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    harness: WorkbenchHarness,
    threadId: string,
  ) {
    const values = (await Promise.all(members.map(async (member) => {
      const state = await this.local.findLifecycleState({ cwd: member.repoRoot, harness, threadId });
      return state ? { member, state } : null;
    }))).flatMap((value) => value ? [value] : []);
    return values.length ? await this.aggregateLifecycle(project, values) : null;
  }

  async listPlanStates(project: AgentEndpointProjectResolution): Promise<WorkspaceGitArcPlanState[]> {
    const members = await this.resolveRepoMembers(project);
    const localStates = (await Promise.all(members.map(async (member) => (
      (await this.local.listPlanStates({ cwd: member.repoRoot })).map((state) => ({ member, state }))
    )))).flat();
    const groups = new Map<string, Array<{ member: RepoMember; state: GitArcPlanState }>>();
    for (const value of localStates) {
      const key = identityKey(value.state.harness, value.state.threadId);
      groups.set(key, [...groups.get(key) ?? [], value]);
    }
    return [...groups.values()].map((values) => this.aggregatePlan(project, values));
  }

  async findPlanState(project: AgentEndpointProjectResolution, harness: WorkbenchHarness, threadId: string) {
    return (await this.listPlanStates(project)).find((state) => (
      state.harness === harness && state.threadId === threadId
    )) ?? null;
  }

  async listActiveClaims(project: AgentEndpointProjectResolution) {
    const states = await this.listLifecycleStates(project);
    return states.filter((state) => state.phase === "active");
  }

  async checkActiveClaimPaths(
    project: AgentEndpointProjectResolution,
    harness: WorkbenchHarness,
    threadId: string,
    absolutePaths: readonly string[],
  ) {
    const members = await this.resolveRepoMembers(project);
    const [lifecycle, ignoredPaths] = await Promise.all([
      this.findLifecycleStateInMembers(project, members, harness, threadId),
      this.listIgnoredPatchPaths(project, members, absolutePaths),
    ]);
    const roots = [...project.project.roots].sort((left, right) => right.root.length - left.root.length);
    const directoryClaims = new Set<string>();
    const claimedPaths = lifecycle?.phase === "active" ? lifecycle.claimedPaths : [];
    for (const claimedPath of claimedPaths) {
      const parsed = this.parseRootPath(project, claimedPath, project.root.id);
      try {
        if ((await fs.stat(parsed.absolute)).isDirectory()) directoryClaims.add(comparable(parsed.absolute));
      } catch {
        // Missing claims cover only their exact path.
      }
    }
    const claims = claimedPaths.map((claimedPath) => comparable(this.parseRootPath(project, claimedPath, project.root.id).absolute));
    const uncoveredPaths = absolutePaths.filter((candidate) => {
      const absolute = comparable(candidate);
      const insideWorkspace = roots.some((root) => isInside(absolute, root.root));
      if (!insideWorkspace) return true;
      if (ignoredPaths.has(absolute)) return false;
      return !claims.some((claim) => absolute === claim || (directoryClaims.has(claim) && isInside(absolute, claim)));
    });
    return { allowed: uncoveredPaths.length === 0, uncoveredPaths };
  }

  async findPlanClaimCollisions(
    project: AgentEndpointProjectResolution,
    request: Extract<GitCheckpointRequest, { action: "arcWait" }>,
  ): Promise<WorkspaceGitArcPlanClaimCollisionResult> {
    const members = await this.resolveRepoMembers(project);
    const refs = this.refsByRepo(project, members, request.refs);
    if (request.checkpointCommit) refs.set(this.memberForRoot(members, project.root).repoRoot, request.checkpointCommit);
    if (!refs.size) {
      const plan = await this.findPlanState(project, request.harness, request.threadId);
      for (const member of plan?.members ?? []) refs.set(member.repoRoot, member.checkpointCommit);
    }
    const selected = members.filter((member) => refs.has(member.repoRoot));
    if (!selected.length) throw new GitArcRejectionError({ reason: "missingInactiveMembers" }, "This workspace Git arc has no matching inactive plan members.");
    const values = await Promise.all(selected.map(async (member) => ({
      member,
      result: await this.local.findPlanClaimCollisions({
        checkpointCommit: refs.get(member.repoRoot),
        cwd: member.repoRoot,
        harness: request.harness,
        threadId: request.threadId,
      }),
    })));
    const decorated = values.map(({ member, result }) => ({
      ...result,
      rootId: member.roots[0]!.id,
      rootIds: member.roots.map(({ id }) => id),
      scopePaths: result.scopePaths.map((scopePath) => this.qualify(project, member, scopePath)),
    }));
    return {
      ...decorated[0]!,
      collisions: decorated.flatMap(({ collisions }) => collisions),
      members: decorated,
      scopePaths: decorated.flatMap(({ scopePaths }) => scopePaths),
    };
  }

  async tryStartWaitingArc(
    project: AgentEndpointProjectResolution,
    request: Extract<GitCheckpointRequest, { action: "arcWait" }>,
    options: { beforeStart(): void; throwIfAborted(): void },
  ) {
    const members = await this.resolveRepoMembers(project);
    const startRequest = {
      ...request,
      action: "arcStart" as const,
    };
    try {
      return {
        kind: "started" as const,
        result: await this.executeRefOperation(project, members, startRequest, {
          beforeStart: options.beforeStart,
          preflightClaims: true,
          throwIfAborted: options.throwIfAborted,
        }),
      };
    } catch (error) {
      if (findWorkspaceGitArcWaitBlockedError(error)) return { kind: "blocked" as const };
      throw error;
    }
  }

  private async listIgnoredPatchPaths(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    absolutePaths: readonly string[],
  ) {
    const roots = [...project.project.roots].sort((left, right) => right.root.length - left.root.length);
    const memberByRootId = new Map(members.flatMap((member) => member.roots.map((root) => [root.id, member] as const)));
    const candidatesByRepo = new Map<string, string[]>();
    for (const candidate of absolutePaths) {
      const root = roots.find((projectRoot) => isInside(candidate, projectRoot.root));
      const member = root ? memberByRootId.get(root.id) : null;
      if (!root || !member || comparable(candidate) === comparable(root.root)) continue;
      candidatesByRepo.set(member.repoRoot, [...candidatesByRepo.get(member.repoRoot) ?? [], candidate]);
    }
    const ignoredPaths = await Promise.all([...candidatesByRepo].map(async ([repoRoot, candidates]) => {
      const repository = new WorkbenchGitRepository(repoRoot);
      return (await repository.listIgnoredPaths(candidates)).map((ignoredPath) => comparable(repository.resolvePath(ignoredPath)));
    }));
    return new Set(ignoredPaths.flat());
  }

  async releaseActiveClaim(project: AgentEndpointProjectResolution, harness: WorkbenchHarness, threadId: string) {
    const members = await this.resolveRepoMembers(project);
    const lifecycle = await this.findLifecycleState(project, harness, threadId);
    const selected = members.filter((member) => lifecycle?.members.some(({ repoRoot }) => repoRoot === member.repoRoot));
    if (!selected.length) return;
    await this.runMembers(
      selected,
      async (member) => await this.local.releaseActiveClaim({ cwd: member.repoRoot, harness, threadId }),
      undefined,
      "write",
      { harness, project, threadId },
    );
  }

  async pruneThreadHistories(
    project: AgentEndpointProjectResolution,
    identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: string }>,
  ): Promise<GitArcRetentionResult> {
    const members = await this.resolveRepoMembers(project);
    const values = await this.runMembers(members, async (member) => {
      const results = [];
      for (const identity of identities) {
        results.push(await this.local.pruneThreadHistory({ cwd: member.repoRoot, ...identity }));
      }
      return results;
    });
    return values.flatMap(({ result }) => result).reduce((total, result) => ({
      prunedRefCount: total.prunedRefCount + result.prunedRefCount,
      registryEntryRemoved: total.registryEntryRemoved || result.registryEntryRemoved,
    }), { prunedRefCount: 0, registryEntryRemoved: false });
  }

  async execute(
    project: AgentEndpointProjectResolution,
    request: GitCheckpointRequest,
    options: { modifiedSince?: number } = {},
  ) {
    const members = await this.resolveRepoMembers(project);
    switch (request.action) {
      case "planClaims":
      case "arcClaims": return await this.executeClaimChanges(project, members, request);
      case "arcScope": {
        const values = await this.runMembers(members, async (member) => await this.local.readScope({
          cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
        }), undefined, "read");
        const present = values.flatMap(({ member, result }) => result ? [{ member, result }] : []);
        return present.length ? this.aggregateResults(project, present) : null;
      }
      case "plan":
      case "planStart": return await this.executePlan(project, members, request);
      case "planAdd":
      case "planAdopt":
      case "planRemove":
      case "arcAdd":
      case "arcAdopt":
      case "arcRemove": return await this.executePathMutation(project, members, request);
      case "arcRelease": return await this.executeRelease(project, members, request);
      case "arcStart":
      case "arcContinue": return await this.executeRefOperation(project, members, request);
      case "arcWait": return await this.findPlanClaimCollisions(project, request);
      case "compare":
      case "diff": {
        if (options.modifiedSince === undefined) {
          throw new Error("Workspace Git arc inspection requires the managed thread creation timestamp.");
        }
        return await this.executeInspection(project, members, request, options.modifiedSince);
      }
      case "arcMove": return await this.executeMove(project, members, request);
      case "proposalCreate": return await this.createProposal(project, members, request);
      case "proposalState":
      case "proposalCommit":
      case "proposalRescind": return await this.executeProposalOperation(project, members, request);
      case "restore": return await this.executeRestore(project, members, request);
      case "readDiffArtifact": return await this.local.readLegacyDiffArtifact({ artifactId: request.diffArtifactId, threadId: request.threadId });
    }
  }

  private async resolveRepoMembers(project: AgentEndpointProjectResolution) {
    const byRepo = new Map<string, RepoMember>();
    for (const root of project.project.roots) {
      const repoRoot = await this.resolveGitRepoRoot(root.root);
      if (!repoRoot) continue;
      const key = comparable(repoRoot);
      const current = byRepo.get(key);
      if (current) current.roots.push(root);
      else byRepo.set(key, { repoRoot, roots: [root] });
    }
    return [...byRepo.values()].map((member) => ({
      ...member,
      roots: member.roots.sort((left, right) => left.id.localeCompare(right.id)),
    })).sort((left, right) => comparable(left.repoRoot).localeCompare(comparable(right.repoRoot)));
  }

  private findRoot(project: AgentEndpointProjectResolution, rootId: string) {
    const normalized = rootId.trim().toLowerCase();
    const root = project.project.roots.find((candidate) => (
      candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
    ));
    if (!root) throw new GitArcRejectionError({ reason: "unknownWorkspaceRoot", rootId }, `Unknown workspace root: ${rootId}`);
    return root;
  }

  private memberForRoot(members: readonly RepoMember[], root: ResolvedProjectRoot) {
    const member = members.find((candidate) => candidate.roots.some(({ id }) => id === root.id));
    if (!member) throw new GitArcRejectionError({ reason: "rootNotRepository", rootId: root.id }, `Workspace root ${root.id} is not inside a Git repository.`);
    return member;
  }

  private rootForRepoPath(member: RepoMember, repoPath: string) {
    const absolute = path.resolve(member.repoRoot, repoPath);
    return [...member.roots].filter((root) => isInside(absolute, root.root))
      .sort((left, right) => comparable(right.root).length - comparable(left.root).length)[0] ?? member.roots[0]!;
  }

  private qualify(project: AgentEndpointProjectResolution, member: RepoMember, repoPath: string) {
    const root = this.rootForRepoPath(member, repoPath);
    const relative = path.relative(root.root, path.resolve(member.repoRoot, repoPath)).replace(/\\/gu, "/");
    return project.project.roots.length > 1 ? `${root.id}:${relative}` : relative;
  }

  private parseRootPath(project: AgentEndpointProjectResolution, rawPath: string, fallbackRootId: string) {
    const explicit = project.project.roots.find((root) => rawPath.toLowerCase().startsWith(`${root.id.toLowerCase()}:`));
    const root = explicit ?? this.findRoot(project, fallbackRootId);
    const value = explicit ? rawPath.slice(root.id.length + 1) : rawPath;
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root.root, value);
    if (!isInside(absolute, root.root)) throw new GitArcRejectionError({ reason: "pathOutsideWorkspaceRoot", rootId: root.id, path: rawPath }, `Git arc path escapes workspace root ${root.id}: ${rawPath}`);
    return { absolute, root };
  }

  private groupRootPaths(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    paths: readonly string[],
    roots: readonly RootPathInput[],
    adoptPaths: readonly string[] = [],
    includeCaller = false,
  ) {
    const grouped = new Map<string, { adoptPaths: string[]; member: RepoMember; paths: string[] }>();
    const install = (rootId: string, values: readonly string[], kind: "adoptPaths" | "paths") => {
      const root = this.findRoot(project, rootId);
      const member = this.memberForRoot(members, root);
      const current = grouped.get(member.repoRoot) ?? { adoptPaths: [], member, paths: [] };
      current[kind].push(...values.map((value) => this.parseRootPath(project, value, root.id).absolute));
      grouped.set(member.repoRoot, current);
    };
    const callerRootId = project.root.id;
    for (const value of paths) {
      const parsed = this.parseRootPath(project, value, callerRootId);
      install(parsed.root.id, [parsed.absolute], "paths");
    }
    for (const value of adoptPaths) {
      const parsed = this.parseRootPath(project, value, callerRootId);
      install(parsed.root.id, [parsed.absolute], "adoptPaths");
    }
    for (const root of roots) {
      install(root.rootId, root.paths, "paths");
      install(root.rootId, root.adoptPaths ?? [], "adoptPaths");
    }
    if (includeCaller && !grouped.size) {
      const root = this.findRoot(project, callerRootId);
      const member = this.memberForRoot(members, root);
      grouped.set(member.repoRoot, { adoptPaths: [], member, paths: [] });
    }
    return [...grouped.values()].map((group) => ({ ...group, adoptPaths: unique(group.adoptPaths), paths: unique(group.paths) }));
  }

  private refsByRepo(project: AgentEndpointProjectResolution, members: readonly RepoMember[], refs: readonly { ref: string; rootId: string }[]) {
    const result = new Map<string, string>();
    for (const entry of refs) {
      const member = this.memberForRoot(members, this.findRoot(project, entry.rootId));
      const existing = result.get(member.repoRoot);
      if (existing && existing !== entry.ref) throw new GitArcRejectionError({ reason: "conflictingRootRefs", rootIds: member.roots.map(({ id }) => id) }, `Workspace roots in ${member.repoRoot} supplied different arc refs.`);
      result.set(member.repoRoot, entry.ref);
    }
    return result;
  }

  private async runMembers<T>(
    selected: readonly RepoMember[],
    operation: (member: RepoMember) => Promise<T>,
    preflight?: (member: RepoMember) => Promise<void>,
    mode: "read" | "write" = "write",
    observation?: { harness: WorkbenchHarness; project: AgentEndpointProjectResolution; threadId: string },
  ) {
    if (!selected.length) throw new GitArcRejectionError({ reason: "missingWorkspaceMembers" }, "This workspace Git arc has no matching repository members.");
    const run = mode === "read" ? this.transitions.readMany.bind(this.transitions) : this.transitions.runMany.bind(this.transitions);
    return await run(selected.map(({ repoRoot }) => repoRoot), async () => {
      try {
        if (preflight) {
          for (const member of selected) {
            try {
              await preflight(member);
            } catch (error) {
              throw new WorkspaceGitArcMemberError({
                failedRootIds: member.roots.map(({ id }) => id), completedRootIds: [], stage: "preflight",
              }, error);
            }
          }
        }
        const results: Array<{ member: RepoMember; result: T }> = [];
        for (const member of selected) {
          try {
            results.push({ member, result: await operation(member) });
          } catch (error) {
            const completed = results.flatMap(({ member: value }) => value.roots.map(({ id }) => id));
            throw new WorkspaceGitArcMemberError({
              failedRootIds: member.roots.map(({ id }) => id), completedRootIds: completed, stage: "operation",
            }, error);
          }
        }
        return results;
      } finally {
        if (observation && mode === "write") await this.observeMemberClaims(selected, observation);
      }
    });
  }

  private async observeMemberClaims(
    members: readonly RepoMember[],
    observation: { harness: WorkbenchHarness; project: AgentEndpointProjectResolution; threadId: string },
  ) {
    if (!this.observeClaimSnapshot) return;
    for (const member of members) {
      try {
        const state = await this.local.findLifecycleState({
          cwd: member.repoRoot,
          harness: observation.harness,
          threadId: observation.threadId,
        });
        const roots = member.roots.map(({ id }) => ({ paths: [] as string[], rootId: id }));
        const expandedPaths = state?.claimedPaths.length
          ? await this.claimHistory.expandScopes({
            checkpointCommit: state.checkpointCommit,
            repositoryRoot: member.repoRoot,
            scopePaths: state.claimedPaths,
          })
          : [];
        for (const claimedPath of expandedPaths) {
          const root = this.rootForRepoPath(member, claimedPath);
          const target = roots.find(({ rootId }) => rootId === root.id)!;
          target.paths.push(path.relative(root.root, path.resolve(member.repoRoot, claimedPath)).replace(/\\/gu, "/") || ".");
        }
        const updatedAt = state ? Date.parse(state.updatedAt) : Number.NaN;
        this.observeClaimSnapshot({
          harness: observation.harness,
          observedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
          projectId: observation.project.project.id,
          roots,
          threadId: observation.threadId,
        });
      } catch (error) {
        console.error(`Git claim observation failed after a workspace mutation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private decorateResult(project: AgentEndpointProjectResolution, member: RepoMember, raw: object) {
    const value = raw as Record<string, unknown>;
    const qualifyPaths = (candidate: unknown) => Array.isArray(candidate)
      ? unique(candidate.filter((entry): entry is string => typeof entry === "string").map((entry) => this.qualify(project, member, entry)))
      : [];
    const changes = Array.isArray(value.changes) ? value.changes.map((change) => {
      const entry = change as Record<string, unknown>;
      const kind = entry.kind && typeof entry.kind === "object" ? entry.kind as Record<string, unknown> : null;
      return {
        ...entry,
        path: typeof entry.path === "string" ? this.qualify(project, member, entry.path) : entry.path,
        ...(kind?.type === "update" && typeof kind.move_path === "string"
          ? { kind: { ...kind, move_path: this.qualify(project, member, kind.move_path) } }
          : {}),
      };
    }) : [];
    return {
      ...value,
      ...(value.planningDrift && typeof value.planningDrift === "object" ? {
        planningDrift: {
          ...value.planningDrift,
          paths: qualifyPaths((value.planningDrift as { paths?: string[] }).paths),
        },
      } : {}),
      ...(Array.isArray(value.acquiredClaims) ? { acquiredClaims: qualifyPaths(value.acquiredClaims) } : {}),
      changes,
      ...(Array.isArray(value.releasedClaims) ? { releasedClaims: qualifyPaths(value.releasedClaims) } : {}),
      repoRoot: member.repoRoot,
      rootId: member.roots[0]!.id,
      rootIds: member.roots.map(({ id }) => id),
      scopePaths: qualifyPaths(value.scopePaths),
      ...(Array.isArray(value.claimedPaths) ? { claimedPaths: qualifyPaths(value.claimedPaths) } : {}),
      ...(Array.isArray(value.plannedPaths) ? { plannedPaths: qualifyPaths(value.plannedPaths) } : {}),
      ...(Array.isArray(value.adoptedPaths) ? { adoptedPaths: qualifyPaths(value.adoptedPaths) } : {}),
      ...(Array.isArray(value.addedClaims) ? { addedClaims: qualifyPaths(value.addedClaims) } : {}),
      ...(Array.isArray(value.removedClaims) ? { removedClaims: qualifyPaths(value.removedClaims) } : {}),
      ...(Array.isArray(value.skippedIgnoredPaths) ? { skippedIgnoredPaths: qualifyPaths(value.skippedIgnoredPaths) } : {}),
      ...(Array.isArray(value.restoredPaths) ? { restoredPaths: qualifyPaths(value.restoredPaths) } : {}),
    };
  }

  private aggregateResults(project: AgentEndpointProjectResolution, values: Array<{ member: RepoMember; result: object }>) {
    const members: Array<Record<string, unknown>> = values.map(({ member, result }) => this.decorateResult(project, member, result));
    const first = members.find((member) => typeof member.checkpointCommit === "string" && member.checkpointCommit.length > 0)
      ?? members[0]
      ?? {};
    const arrays = (name: string) => members.flatMap((member) => Array.isArray(member[name]) ? member[name] as unknown[] : []);
    return {
      ...first,
      ...(members.some((member) => typeof member.phase === "string") ? {
        phase: members.some((member) => member.phase === "plan") ? "plan" : members.some((member) => member.phase === "active") ? "active" : "resolved",
      } : {}),
      ...(members.every((member) => typeof member.unchanged === "boolean") ? { unchanged: members.every((member) => member.unchanged === true) } : {}),
      acquiredClaims: arrays("acquiredClaims"),
      changes: arrays("changes"),
      ...(members.every((member) => typeof member.hasUncommittedChanges === "boolean") ? {
        hasUncommittedChanges: members.some((member) => member.hasUncommittedChanges === true),
      } : {}),
      members,
      noOp: members.length > 0 && members.every((member) => member.noOp === true),
      releasedClaims: arrays("releasedClaims"),
      restoredPaths: arrays("restoredPaths"),
      scopePaths: arrays("scopePaths"),
      claimedPaths: arrays("claimedPaths"),
      plannedPaths: arrays("plannedPaths"),
      adoptedPaths: arrays("adoptedPaths"),
      addedClaims: arrays("addedClaims"),
      removedClaims: arrays("removedClaims"),
      skippedIgnoredPaths: arrays("skippedIgnoredPaths"),
      ...(members.some((member) => typeof member.diff === "string") ? {
        diff: members.map((member) => `### ${member.rootId}\n${String(member.diff ?? "")}`).join("\n\n"),
      } : {}),
    };
  }

  private async executeClaimChanges(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "planClaims" | "arcClaims" }>,
  ) {
    const additions = this.groupRootPaths(project, members, request.addPaths, request.roots.map((root) => ({
      rootId: root.rootId, paths: root.addPaths, adoptPaths: root.adoptPaths,
    })), request.adoptPaths);
    const removals = this.groupRootPaths(project, members, request.removePaths, request.roots.map((root) => ({
      rootId: root.rootId, paths: root.removePaths,
    })));
    const inventories = await Promise.all(members.map(async (member) => ({
      member, scope: await this.local.readScope({ cwd: member.repoRoot, harness: request.harness, threadId: request.threadId }),
    })));
    const inheritedIntent = inventories.find(({ scope }) => scope)?.scope?.intentName;
    const selected = members.filter((member) => inventories.some((entry) => entry.member === member && entry.scope)
      || additions.some((group) => group.member === member) || removals.some((group) => group.member === member));
    if (!selected.length) selected.push(this.memberForRoot(members, project.root));
    const values = await this.runMembers(selected, async (member) => {
      const scope = inventories.find((entry) => entry.member === member)?.scope;
      const addition = additions.find((group) => group.member === member);
      const removePaths = removals.find((group) => group.member === member)?.paths ?? [];
      const input = {
        cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
        addPaths: addition?.paths ?? [], adoptPaths: addition?.adoptPaths ?? [], removePaths,
        inherit: request.inherit,
      };
      if (request.action === "arcClaims" && scope) return await this.local.editArcClaims(input);
      if (!scope && removePaths.length) throw new GitArcRejectionError({ reason: "unclaimedRemoval", paths: removePaths }, "Removed paths must exactly match inherited entries.");
      return await this.local.editPlanClaims({
        ...input,
        inherit: Boolean(scope) && request.inherit,
        intentName: request.action === "planClaims" ? request.intentName ?? (!scope ? inheritedIntent : undefined) : inheritedIntent,
        ...(request.action === "planClaims" ? { intentDescription: request.intentDescription } : {}),
        start: request.action === "arcClaims" || request.start,
      });
    }, undefined, "write", { harness: request.harness, project, threadId: request.threadId });
    return this.aggregateResults(project, values);
  }

  private async executePlan(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "plan" | "planStart" }>,
  ) {
    const groups = this.groupRootPaths(project, members, request.paths, request.roots, request.adoptPaths, true);
    const values = await this.runMembers(groups.map(({ member }) => member), async (member) => {
      const group = groups.find((candidate) => candidate.member.repoRoot === member.repoRoot)!;
      const input = {
        adoptPaths: group.adoptPaths, cwd: member.repoRoot, harness: request.harness,
        intentDescription: request.intentDescription, intentName: request.intentName, paths: group.paths,
        threadId: request.threadId,
      };
      return request.action === "plan"
        ? await this.local.createPlan(input)
        : await this.local.createAndStartPlan(input);
    }, undefined, "write", { harness: request.harness, project, threadId: request.threadId });
    return this.aggregateResults(project, values);
  }

  private async executePathMutation(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "arcAdd" | "arcAdopt" | "arcRemove" | "planAdd" | "planAdopt" | "planRemove" }>,
  ) {
    const groups = this.groupRootPaths(project, members, request.paths, request.roots);
    const values = await this.runMembers(groups.map(({ member }) => member), async (member) => {
      const paths = groups.find((candidate) => candidate.member.repoRoot === member.repoRoot)!.paths;
      const input = { cwd: member.repoRoot, harness: request.harness, paths, threadId: request.threadId };
      switch (request.action) {
        case "planAdd": return await this.local.addToPlan(input);
        case "planAdopt": return await this.local.adoptIntoPlan(input);
        case "planRemove": return await this.local.removeFromPlan(input);
        case "arcAdd": return await this.local.addToArc(input);
        case "arcAdopt": return await this.local.adoptIntoArc(input);
        case "arcRemove": return await this.local.removeFromArc(input);
      }
    }, undefined, "write", { harness: request.harness, project, threadId: request.threadId });
    return this.aggregateResults(project, values);
  }

  private async executeRelease(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "arcRelease" }>,
  ) {
    const lifecycle = await this.findLifecycleStateInMembers(project, members, request.harness, request.threadId);
    const claimedRepoRoots = new Set(lifecycle?.members
      .filter(({ claimedPaths }) => claimedPaths.length > 0)
      .map(({ repoRoot }) => repoRoot));
    const selected = members.filter((member) => claimedRepoRoots.has(member.repoRoot));
    const values = await this.runMembers(
      selected,
      async (member) => await this.local.releaseArc({
        cwd: member.repoRoot, disown: request.disown, harness: request.harness, threadId: request.threadId,
      }),
      request.disown ? undefined : async (member) => await this.local.assertArcReleasable({
        cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
      }),
      "write",
      { harness: request.harness, project, threadId: request.threadId },
    );
    return this.aggregateResults(project, values);
  }

  private async executeRefOperation(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "arcContinue" | "arcStart" }>,
    options: {
      beforeStart?: () => void;
      preflightClaims?: boolean;
      throwIfAborted?: () => void;
    } = {},
  ) {
    const refs = this.refsByRepo(project, members, request.refs);
    if (request.checkpointCommit) refs.set(this.memberForRoot(members, project.root).repoRoot, request.checkpointCommit);
    if (!refs.size) {
      if (request.action === "arcContinue") {
        for (const member of members) {
          const scope = await this.local.readScope({ cwd: member.repoRoot, harness: request.harness, threadId: request.threadId });
          if (scope && scope.phase !== "plan") refs.set(member.repoRoot, scope.checkpointCommit);
        }
      } else {
        const plans = await this.listPlanStates(project);
        for (const plan of plans.filter((state) => state.harness === request.harness && state.threadId === request.threadId)) {
          for (const member of plan.members) refs.set(member.repoRoot, member.checkpointCommit);
        }
      }
    }
    const selected = members.filter((member) => refs.has(member.repoRoot));
    let started = false;
    const values = await this.runMembers(
      selected,
      async (member) => {
        const checkpointCommit = refs.get(member.repoRoot)!;
        if (request.action === "arcStart") {
          if (!started) {
            options.throwIfAborted?.();
            options.beforeStart?.();
            started = true;
          }
          return await this.local.startArc({
            checkpointCommit, cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
          });
        }
        return await this.local.continueArc({
          checkpointCommit, cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
        });
      },
      options.preflightClaims ? async (member) => {
        options.throwIfAborted?.();
        const result = await this.local.findPlanClaimCollisions({
          checkpointCommit: refs.get(member.repoRoot),
          cwd: member.repoRoot,
          harness: request.harness,
          threadId: request.threadId,
        });
        if (result.collisions.length) throw new WorkspaceGitArcWaitBlockedError();
      } : undefined,
      "write",
      { harness: request.harness, project, threadId: request.threadId },
    );
    return this.aggregateResults(project, values);
  }

  private async executeInspection(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "compare" | "diff" }>,
    modifiedSince: number,
  ) {
    const groups = this.groupRootPaths(project, members, request.paths ?? [], request.roots);
    const refs = this.refsByRepo(project, members, request.refs);
    if (request.ref) refs.set(this.memberForRoot(members, project.root).repoRoot, request.ref);
    let selected = unique([...groups.map(({ member }) => member.repoRoot), ...refs.keys()])
      .map((repoRoot) => members.find((member) => member.repoRoot === repoRoot)!);
    if (!selected.length) {
      const lifecycle = await this.findLifecycleState(project, request.harness, request.threadId);
      const plan = await this.findPlanState(project, request.harness, request.threadId);
      selected = unique([...(lifecycle?.members ?? []), ...(plan?.members ?? [])].map(({ repoRoot }) => repoRoot))
        .map((repoRoot) => members.find((member) => member.repoRoot === repoRoot)!);
    }
    if (!selected.length) throw new GitArcRejectionError({ reason: "missingWorkspaceMembers" }, "This workspace Git arc has no matching repository members.");
    const selectedRepos = new Set(selected.map(({ repoRoot }) => repoRoot));
    const values = await this.runMembers(members, async (member) => {
      const inspectionSnapshot = await this.local.createInspectionSnapshot(member.repoRoot);
      const unclaimedDirt = this.local.listUnclaimedWorkspaceDirt({
        cwd: member.repoRoot,
        modifiedSince,
      }, inspectionSnapshot);
      if (!selectedRepos.has(member.repoRoot)) {
        return { inspection: null, unclaimedDirtPaths: await unclaimedDirt };
      }
      const group = groups.find((candidate) => candidate.member.repoRoot === member.repoRoot);
      const input = {
        cwd: member.repoRoot, harness: request.harness, threadId: request.threadId,
        ...(group?.paths.length ? { paths: group.paths } : {}),
        ...(refs.get(member.repoRoot) ? { ref: refs.get(member.repoRoot) } : {}),
      };
      const [inspection, unclaimedDirtPaths] = await Promise.all([
        this.local.compare(input, inspectionSnapshot),
        unclaimedDirt,
      ]);
      return {
        inspection,
        unclaimedDirtPaths,
      };
    }, undefined, "read");
    const inspectionValues = values.flatMap(({ member, result }) => (
      result.inspection ? [{ member, result: result.inspection }] : []
    ));
    const unclaimedDirtPaths = unique(values.flatMap(({ member, result }) => (
      result.unclaimedDirtPaths.map((candidate) => this.qualify(project, member, candidate))
    ))).sort((left, right) => left.localeCompare(right));
    const aggregated = this.aggregateResults(project, inspectionValues);
    if (request.action === "compare") return { ...aggregated, unclaimedDirtPaths };

    const units = inspectionValues.flatMap(({ member, result }) => {
      const decorated = this.decorateResult(project, member, result);
      const changes = decorated.changes as GitCheckpointFileChange[];
      const rootId = decorated.rootId as string;
      return changes.map((change) => ({
        change,
        content: change.diff,
        ...(project.project.roots.length > 1 ? { groupHeading: `### ${rootId}` } : {}),
      }));
    });
    const page = createGitArcDiffPage(units, {
      ...(request.page !== undefined ? { page: request.page } : {}),
      paginate: !request.paths?.length && !request.roots.some(({ paths }) => paths.length > 0),
    });
    const aggregatedMembers = Array.isArray(aggregated.members)
      ? aggregated.members.map((member) => ({ ...member, changes: [] }))
      : aggregated.members;
    return {
      ...aggregated,
      ...page,
      members: aggregatedMembers,
      unclaimedDirtPaths,
    };
  }

  private translateMove(root: ResolvedProjectRoot, move: Extract<GitCheckpointRequest, { action: "arcMove" }>["move"]) {
    const absolute = (value: string) => path.isAbsolute(value) ? value : path.resolve(root.root, value);
    if (move.kind === "maps") return { ...move, mappings: move.mappings.map(({ destination, source }) => ({ destination: absolute(destination), source: absolute(source) })) };
    if (move.kind === "regex") return { ...move, roots: move.roots.map(absolute) };
    return { ...move, operands: move.operands.map(absolute) };
  }

  private async executeMove(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "arcMove" }>,
  ) {
    const root = this.findRoot(project, request.rootId ?? project.root.id);
    const member = this.memberForRoot(members, root);
    const values = await this.runMembers([member], async () => await this.local.moveInArc({
      cwd: member.repoRoot, harness: request.harness, move: this.translateMove(root, request.move), threadId: request.threadId,
    }), undefined, request.move.kind === "regex" && !request.move.confirm ? "read" : "write", {
      harness: request.harness,
      project,
      threadId: request.threadId,
    });
    return this.aggregateResults(project, values);
  }

  private async createProposal(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "proposalCreate" }>,
  ) {
    const targetedAmend = Boolean(request.amendProposalId);
    const messageOnlyAmend = Boolean(targetedAmend && !request.amend && !request.paths?.length);
    const inferredMember = targetedAmend && !request.rootId
      ? await this.findProposalMember(members, { harness: request.harness, proposalId: request.amendProposalId, threadId: request.threadId })
      : null;
    if (project.project.roots.length > 1 && !request.rootId && !inferredMember) {
      throw new GitArcRejectionError({ reason: "missingProposalRoot" }, "A multi-root Git arc proposal requires rootId so one proposal cannot cross projects.");
    }
    const root = inferredMember?.roots[0] ?? this.findRoot(project, request.rootId ?? project.root.id);
    const member = inferredMember ?? this.memberForRoot(members, root);
    const requestedPaths = request.paths?.map((value) => this.parseRootPath(project, value, root.id));
    if (requestedPaths?.some((candidate) => candidate.root.id !== root.id)) {
      throw new GitArcRejectionError({ reason: "crossRootProposal", rootId: root.id }, `A Git arc proposal for ${root.id} cannot include paths from another workspace root.`);
    }
    let selectedPaths = requestedPaths?.map(({ absolute }) => absolute);
    if (!messageOnlyAmend && !selectedPaths?.length && project.project.roots.length > 1) {
      const state = await this.local.findLifecycleState({ cwd: member.repoRoot, harness: request.harness, threadId: request.threadId });
      selectedPaths = state?.claimedPaths.filter((candidate) => this.rootForRepoPath(member, candidate).id === root.id) ?? [];
    }
    if (!messageOnlyAmend && project.project.roots.length > 1 && !request.amend && !selectedPaths?.length) {
      throw new GitArcRejectionError({ reason: "noClaimedRootPaths", rootId: root.id }, `Workspace root ${root.id} has no claimed paths to propose.`);
    }
    const values = await this.runMembers([member], async () => await this.local.createProposal({
      amend: request.amend,
      ...(request.amendProposalId ? { amendProposalId: request.amendProposalId } : {}),
      cwd: member.repoRoot, description: request.description, harness: request.harness,
      ...(request.freshDescription !== undefined ? { freshDescription: request.freshDescription } : {}),
      ...(request.freshTitle ? { freshTitle: request.freshTitle } : {}),
      ...(selectedPaths?.length ? { paths: selectedPaths } : {}),
      ...(request.replaceProposalId ? { replaceProposalId: request.replaceProposalId } : {}),
      threadId: request.threadId, title: request.title,
    }), undefined, "write", { harness: request.harness, project, threadId: request.threadId });
    const proposal = values[0]!.result;
    return { ...proposal, rootId: root.id };
  }

  private async findProposalMember(members: readonly RepoMember[], request: { harness: WorkbenchHarness; proposalId: string; threadId: string }) {
    for (const member of members) {
      try {
        await this.local.getProposal({ cwd: member.repoRoot, harness: request.harness, includeNewer: false, proposalId: request.proposalId, threadId: request.threadId });
        return member;
      } catch (error) {
        if (!(error instanceof GitArcRejectionError) || error.rejection.reason !== "proposalNotFound") throw error;
      }
    }
    throw new GitArcRejectionError({ reason: "proposalNotFound", proposalId: request.proposalId }, `Git arc proposal not found: ${request.proposalId}`);
  }

  private async executeProposalOperation(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "proposalCommit" | "proposalRescind" | "proposalState" }>,
  ) {
    const member = await this.findProposalMember(members, request);
    const values = await this.runMembers([member], async () => {
      if (request.action === "proposalState") return await this.local.getProposal({ ...request, cwd: member.repoRoot });
      if (request.action === "proposalRescind") return await this.local.rescindProposal({ ...request, cwd: member.repoRoot });
      return await this.local.commitProposal({ ...request, cwd: member.repoRoot });
    }, undefined, request.action === "proposalState" ? "read" : "write", request.action === "proposalState" ? undefined : {
      harness: request.harness,
      project,
      threadId: request.threadId,
    });
    const result = values[0]!.result;
    const proposalPaths = "paths" in result && Array.isArray(result.paths) ? result.paths : [];
    const roots = unique(proposalPaths.map((candidate) => this.rootForRepoPath(member, candidate).id));
    return { ...result, rootId: roots[0] ?? member.roots[0]!.id };
  }

  private async executeRestore(
    project: AgentEndpointProjectResolution,
    members: readonly RepoMember[],
    request: Extract<GitCheckpointRequest, { action: "restore" }>,
  ) {
    const groups = this.groupRootPaths(project, members, request.paths ?? [], request.roots);
    const refs = this.refsByRepo(project, members, request.refs);
    if (request.checkpointCommit) refs.set(this.memberForRoot(members, project.root).repoRoot, request.checkpointCommit);
    if (request.confirmRestore && !refs.size) {
      const lifecycle = await this.findLifecycleState(project, request.harness, request.threadId);
      for (const member of lifecycle?.members ?? []) refs.set(member.repoRoot, member.checkpointCommit);
    }
    const selected = unique([...groups.map(({ member }) => member.repoRoot), ...refs.keys()])
      .map((repoRoot) => members.find((member) => member.repoRoot === repoRoot)!);
    const values = await this.runMembers(selected, async (member) => {
      const group = groups.find((candidate) => candidate.member.repoRoot === member.repoRoot);
      const checkpointCommit = refs.get(member.repoRoot);
      if (!checkpointCommit) throw new GitArcRejectionError({ reason: "missingRestoreRef", rootId: member.roots[0]!.id }, `Restore is missing the current ref for ${member.roots[0]!.id}.`);
      return await this.local.restore({
        checkpointCommit, confirmRestore: request.confirmRestore, cwd: member.repoRoot, harness: request.harness,
        ...(group?.paths.length ? { paths: group.paths } : {}), threadId: request.threadId,
      });
    }, undefined, "write", { harness: request.harness, project, threadId: request.threadId });
    return this.aggregateResults(project, values);
  }

  private async aggregateLifecycle(
    project: AgentEndpointProjectResolution,
    values: Array<{ member: RepoMember; state: GitArcLifecycleState }>,
  ): Promise<WorkspaceGitArcLifecycleState> {
    const members = await Promise.all(values.map(async ({ member, state }): Promise<WorkspaceGitArcMemberState> => ({
      ...state,
      claimedPaths: state.claimedPaths.map((candidate) => this.qualify(project, member, candidate)),
      proposals: await Promise.all(state.proposals.map(async (proposal) => {
        const paths = await this.local.getProposalPaths({ cwd: member.repoRoot, harness: state.harness as WorkbenchHarness, proposalId: proposal.proposalId, threadId: state.threadId });
        const roots = unique(paths.map((candidate) => this.rootForRepoPath(member, candidate).id));
        return { ...proposal, rootId: roots[0] ?? member.roots[0]!.id };
      })),
      repoRoot: member.repoRoot,
      rootId: member.roots[0]!.id,
      rootIds: member.roots.map(({ id }) => id),
    })));
    const first = members[0]!;
    return {
      checkpointCommit: first.checkpointCommit,
      claimedPaths: members.flatMap(({ claimedPaths }) => claimedPaths),
      harness: first.harness,
      intentDescription: first.intentDescription,
      intentName: first.intentName,
      members,
      phase: members.some(({ phase }) => phase === "active") ? "active" : "resolved",
      proposals: members.flatMap(({ proposals }) => proposals),
      threadId: first.threadId,
      updatedAt: members.map(({ updatedAt }) => updatedAt).sort().at(-1) ?? first.updatedAt,
    };
  }

  private aggregatePlan(
    project: AgentEndpointProjectResolution,
    values: Array<{ member: RepoMember; state: GitArcPlanState }>,
  ): WorkspaceGitArcPlanState {
    const members = values.map(({ member, state }): WorkspaceGitArcPlanMemberState => ({
      ...state,
      repoRoot: member.repoRoot,
      rootId: member.roots[0]!.id,
      rootIds: member.roots.map(({ id }) => id),
      scopePaths: state.scopePaths.map((candidate) => this.qualify(project, member, candidate)),
    }));
    const first = members[0]!;
    return {
      checkpointCommit: first.checkpointCommit,
      harness: first.harness,
      intentDescription: first.intentDescription,
      intentName: first.intentName,
      members,
      scopePaths: members.flatMap(({ scopePaths }) => scopePaths),
      threadId: first.threadId,
      updatedAt: members.map(({ updatedAt }) => updatedAt).sort().at(-1) ?? first.updatedAt,
    };
  }
}
