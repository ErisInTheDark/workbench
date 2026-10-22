/*
 * Exports:
 * - NestedGitWorktreeCatalogProject: catalogue fields nested worktree discovery reads.
 * - NestedGitWorktreeRoot: Git arc root for a catalogued linked worktree inside a project root, naming its own catalogue owner.
 * - isNestedGitWorktreeOf: whether a path is a linked worktree located inside, and registered by, a checkout.
 * - isNestedGitWorktreeRoot: narrow a workspace root to a nested worktree root.
 * - withNestedGitWorktreeRoots: add a project's catalogued nested worktrees to its Git arc roots.
 * - isConfiguredMultiRoot: whether a project has several catalogue roots, ignoring nested worktree and machine roots.
 * - qualifiesGitArcRoot: whether Git arc paths in a root carry its `id:` prefix; machine roots never do.
 * - claimSnapshotsFor: split claim stats by owning catalogue project, so nested worktree paths count for the worktree itself.
 */
import path from "node:path";
import { isSamePath } from "workbench-shared/same-path";
import type { WorkbenchProjectOption } from "workbench-shared/types";

import { readRegisteredGitWorktrees, resolveGitDirectory } from "../lib/git";
import { isPathWithinRoot, normalizeRelativePath, type ResolvedProjectRoot } from "../lib/project";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { WorkbenchGitClaimSnapshot } from "../stats/git-claim-observation";
import { isMachineGitArcRoot } from "./machine-git-arc-roots";

export type NestedGitWorktreeCatalogProject = Pick<WorkbenchProjectOption, "id" | "kind" | "rootPath" | "roots">;

export interface NestedGitWorktreeRoot extends ResolvedProjectRoot {
  nestedWorktree: { projectId: string; rootId: string };
}

function isStrictlyInside(candidate: string, root: string) {
  return !isSamePath(candidate, root) && isPathWithinRoot(candidate, root);
}

async function readRegisteredWorktrees(checkout: string) {
  return await resolveGitDirectory(checkout) ? await readRegisteredGitWorktrees(checkout) : [];
}

export async function isNestedGitWorktreeOf(location: string, candidate: string) {
  if (!isStrictlyInside(candidate, location)) return false;
  return (await readRegisteredWorktrees(location)).some(registered => isSamePath(registered, candidate));
}

export function isNestedGitWorktreeRoot(root: ResolvedProjectRoot): root is NestedGitWorktreeRoot {
  return "nestedWorktree" in root && typeof root.nestedWorktree === "object" && root.nestedWorktree !== null;
}

function rootIdText(value: string) {
  return value.trim().replace(/[:\s]+/gu, "-") || "worktree";
}

/**
 * Only catalogued worktrees join: their registries resolve owners through the catalogue, which rejects unregistered
 * locations. A basename id is used unless it collides; colliding worktrees use their containing-root path, so an id
 * never depends on which siblings exist.
 */
export async function withNestedGitWorktreeRoots(
  resolution: AgentEndpointProjectResolution,
  catalogProjects: readonly NestedGitWorktreeCatalogProject[],
): Promise<AgentEndpointProjectResolution> {
  const configured = resolution.project.roots;
  const found: Array<{ containing: ResolvedProjectRoot; owner: NestedGitWorktreeCatalogProject }> = [];
  for (const root of configured) {
    const inside = catalogProjects.filter(candidate => candidate.kind === "git"
      && candidate.roots.length > 0
      && isStrictlyInside(candidate.rootPath, root.root)
      && !found.some(({ owner }) => isSamePath(owner.rootPath, candidate.rootPath)));
    if (!inside.length) continue;
    const registered = await readRegisteredWorktrees(root.root);
    for (const owner of inside) {
      if (!registered.some(candidate => isSamePath(candidate, owner.rootPath))) continue;
      if (!await resolveGitDirectory(owner.rootPath)) continue;
      found.push({ containing: root, owner });
    }
  }
  if (!found.length) return resolution;
  const taken = new Set(configured.flatMap(({ id, name }) => [id.toLowerCase(), name.toLowerCase()]));
  const basenameCounts = new Map<string, number>();
  for (const { owner } of found) {
    const key = rootIdText(path.basename(owner.rootPath)).toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  }
  const nested: NestedGitWorktreeRoot[] = [];
  for (const { containing, owner } of found) {
    const absolute = path.resolve(owner.rootPath);
    const name = path.basename(absolute);
    const relativePath = normalizeRelativePath(path.relative(containing.root, absolute));
    const basenameId = rootIdText(name);
    const id = taken.has(basenameId.toLowerCase()) || basenameCounts.get(basenameId.toLowerCase())! > 1
      ? rootIdText(relativePath.replace(/\/+/gu, "-"))
      : basenameId;
    if (taken.has(id.toLowerCase()) || nested.some(root => root.id.toLowerCase() === id.toLowerCase())) {
      console.warn(`[git arc] nested worktree root id ${id.slice(0, 200)} is ambiguous; the worktree stays outside its containing project's arc.`);
      continue;
    }
    nested.push({
      id, name, relativePath, root: absolute, rootPath: normalizeRelativePath(absolute),
      nestedWorktree: { projectId: owner.id, rootId: owner.roots[0]!.id },
    });
  }
  return { ...resolution, project: { ...resolution.project, roots: [...configured, ...nested] } };
}

export function isConfiguredMultiRoot(project: AgentEndpointProjectResolution) {
  return project.project.roots.filter(root => !isNestedGitWorktreeRoot(root) && !isMachineGitArcRoot(root)).length > 1;
}

/** Machine roots never qualify: their paths read as absolute machine paths instead. */
export function qualifiesGitArcRoot(project: AgentEndpointProjectResolution, root: ResolvedProjectRoot) {
  if (isMachineGitArcRoot(root)) return false;
  return isNestedGitWorktreeRoot(root) || isConfiguredMultiRoot(project);
}

export function claimSnapshotsFor(
  base: Omit<WorkbenchGitClaimSnapshot, "projectId" | "roots">,
  project: AgentEndpointProjectResolution,
  rootPaths: ReadonlyArray<{ paths: string[]; root: ResolvedProjectRoot }>,
): WorkbenchGitClaimSnapshot[] {
  const own = rootPaths.filter(({ root }) => !isNestedGitWorktreeRoot(root));
  const snapshots: WorkbenchGitClaimSnapshot[] = own.length
    ? [{ ...base, projectId: project.project.id, roots: own.map(({ paths, root }) => ({ paths, rootId: root.id })) }]
    : [];
  for (const { paths, root } of rootPaths) {
    if (!isNestedGitWorktreeRoot(root)) continue;
    snapshots.push({ ...base, projectId: root.nestedWorktree.projectId, roots: [{ paths, rootId: root.nestedWorktree.rootId }] });
  }
  return snapshots;
}
