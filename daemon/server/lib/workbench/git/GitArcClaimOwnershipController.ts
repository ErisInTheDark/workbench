/*
 * Exports:
 * - default GitArcClaimOwnershipController: project and validate active ownership, baseline guards and their durable union.
 * - GitArcClaimOwnership: one owner's active, baseline and guard path sets.
 * - projectGitArcClaimOwnership: enforce and project the active/baseline/guard ownership algebra.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import GitArcRegistry, { getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcStackController from "./GitArcStackController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

export interface GitArcClaimOwnership {
  activeClaims: string[];
  baselineClaims: string[];
  guardClaims: string[];
}

function sorted(paths: Iterable<string>) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function projectGitArcClaimOwnership(input: {
  baselineClaims: readonly string[];
  changedBaselineClaims: readonly string[];
  guardClaims: readonly string[];
  storedActiveClaims?: readonly string[];
}): GitArcClaimOwnership {
  const guardClaims = sorted(input.guardClaims);
  const guards = new GitArcPathSet(guardClaims);
  const baselineClaims = sorted(input.baselineClaims);
  const baseline = new GitArcPathSet(baselineClaims);
  const explicitActive = input.storedActiveClaims === undefined
    ? guardClaims.filter(path => !baseline.covers(path))
    : sorted(input.storedActiveClaims);
  const activeClaims = sorted([...explicitActive, ...input.changedBaselineClaims]);
  const uncovered = [...activeClaims, ...baselineClaims].filter(path => !guards.covers(path));
  if (uncovered.length) {
    throw new Error(`Git arc ownership is inconsistent; guards do not cover: ${sorted(uncovered).join(", ")}`);
  }
  return { activeClaims, baselineClaims, guardClaims };
}

function lifecycle(entry: GitArcRegistryEntry) {
  return entry.phase === "plan" && entry.retainedArc ? entry.retainedArc : entry;
}

export default class GitArcClaimOwnershipController {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private async ownedBaselineClaims(entry: GitArcRegistryEntry) {
    if (!entry.stackTip) return [];
    const guards = new GitArcPathSet(getGitArcLiveClaimPaths(entry));
    const stack = new GitArcStackController(this.repository, this.resolveThreadIdentity);
    return (await stack.pendingOwnBaselinePaths(entry)).filter(path => guards.covers(path));
  }

  async project(entry: GitArcRegistryEntry, worktreeTree?: string | null): Promise<GitArcClaimOwnership> {
    const guardClaims = sorted(getGitArcLiveClaimPaths(entry));
    if (!guardClaims.length) return { activeClaims: [], baselineClaims: [], guardClaims: [] };
    const baselineClaims = await this.ownedBaselineClaims(entry);
    const storedActive = lifecycle(entry).activeClaimedPaths;
    if (!baselineClaims.length) {
      return projectGitArcClaimOwnership({
        baselineClaims,
        changedBaselineClaims: [],
        guardClaims,
        ...(storedActive !== undefined ? { storedActiveClaims: storedActive } : {}),
      });
    }
    const tree = worktreeTree ?? await this.repository.writeScopedWorktreeTree(guardClaims);
    const changedBaseline = entry.stackTip && baselineClaims.length
      ? await this.repository.listChangedPaths(entry.stackTip, tree, baselineClaims)
      : [];
    return projectGitArcClaimOwnership({
      baselineClaims,
      changedBaselineClaims: changedBaseline,
      guardClaims,
      ...(storedActive !== undefined ? { storedActiveClaims: storedActive } : {}),
    });
  }

  assertConserved({ activeClaims, baselineClaims, guardClaims }: GitArcClaimOwnership) {
    const guards = new GitArcPathSet(guardClaims);
    const uncovered = [...activeClaims, ...baselineClaims].filter(path => !guards.covers(path));
    if (uncovered.length) {
      throw new Error(`Git arc ownership is inconsistent; guards do not cover: ${sorted(uncovered).join(", ")}`);
    }
  }

  withActiveClaims(entry: GitArcRegistryEntry, activeClaimedPaths: readonly string[]): GitArcRegistryEntry {
    const active = sorted(activeClaimedPaths);
    const guards = new GitArcPathSet(getGitArcLiveClaimPaths(entry));
    const uncovered = active.filter(path => !guards.covers(path));
    if (uncovered.length) throw new Error(`Active claims lack ownership guards: ${uncovered.join(", ")}`);
    if (entry.phase === "plan" && entry.retainedArc) {
      return { ...entry, retainedArc: { ...entry.retainedArc, activeClaimedPaths: active } };
    }
    return { ...entry, activeClaimedPaths: active };
  }

  async find(identity: { harness: string; threadId: string }, worktreeTree?: string | null) {
    const entry = await new GitArcRegistry(this.repository, this.resolveThreadIdentity).find(identity);
    return entry ? { entry, ownership: await this.project(entry, worktreeTree) } : null;
  }
}
