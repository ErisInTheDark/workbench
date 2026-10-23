/*
 * Exports:
 * - MachineGitArcRoot: Git arc root over a filesystem root, backed by a Workbench-internal Git dir.
 * - isMachineGitArcRoot: narrow a workspace root to a machine root.
 * - withMachineGitArcRoots: add machine roots to a daemon project's Git arc roots, ensuring their Git dirs.
 * - machineArcPathRejection: why an absolute path cannot carry machine Git arc scope, or null; paths inside other
 *   repositories qualify only when that repository ignores them.
 * - machineArcDisplayPath: the absolute path agents see for a machine root path.
 * Daemon projects keep their catalogue roots (the scratch workspace); machine roots exist only for Git arcs, the way
 * nested worktree roots do. Windows gets the system drive, drives that already have machine Git dirs, and drives named
 * by the current request.
 */
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

import { comparablePath as comparable } from "../lib/comparable-path";
import { isDaemonWorkspacePath } from "../lib/daemon-workspace-paths";
import { isPathWithinRoot, normalizeRelativePath, type ResolvedProjectRoot } from "../lib/project";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import { gitProcesses, GitProcessError } from "../lib/workbench/git/GitProcessHost";
import {
  defaultMachineGitBase, ensureMachineGitWorktree, listMachineGitWorktreeRoots,
} from "../lib/workbench/git/machine-git-worktrees";

export interface MachineGitArcRoot extends ResolvedProjectRoot {
  machine: true;
}

export function isMachineGitArcRoot(root: ResolvedProjectRoot): root is MachineGitArcRoot {
  return "machine" in root && root.machine === true;
}

function filesystemRoot(candidate: string) {
  return path.parse(path.resolve(candidate)).root;
}

function rootId(root: string) {
  return /^[a-z]:/iu.test(root) ? root[0]!.toLowerCase() : "machine";
}

async function machineRoots(requestPaths: readonly string[], base: string) {
  if (process.platform !== "win32") return ["/"];
  const named = requestPaths.filter(candidate => /^[a-z]:[\\/]/iu.test(candidate)).map(filesystemRoot);
  const roots = [filesystemRoot(resolveWorkbenchDataRoot()), ...await listMachineGitWorktreeRoots(base), ...named];
  return [...new Map(roots.map(root => [comparable(root), root])).values()];
}

export async function withMachineGitArcRoots(
  resolution: AgentEndpointProjectResolution,
  requestPaths: readonly string[] = [],
  base = defaultMachineGitBase(),
): Promise<AgentEndpointProjectResolution> {
  if (resolution.project.kind !== "daemon") return resolution;
  const machine: MachineGitArcRoot[] = [];
  for (const root of await machineRoots(requestPaths, base)) {
    try {
      await fs.stat(root);
      await ensureMachineGitWorktree(root, base);
    } catch (error) {
      console.warn(`[git arc] machine root ${root} is unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      continue;
    }
    const id = rootId(root);
    machine.push({ id, machine: true, name: id, root, rootPath: normalizeRelativePath(root) });
  }
  return { ...resolution, project: { ...resolution.project, roots: [...resolution.project.roots, ...machine] } };
}

/** The nearest directory between a path and its machine root (exclusive) holding a `.git` marker. */
async function containingRepository(absolute: string, machineRoot: string) {
  const boundary = comparable(machineRoot);
  for (let directory = absolute; comparable(directory) !== boundary; directory = path.dirname(directory)) {
    try {
      await fs.stat(path.join(directory, ".git"));
      return directory;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
    }
    if (path.dirname(directory) === directory) return null;
  }
  return null;
}

/** Ignored files have no owner inside their repository; tracked or trackable ones belong to its project arcs. */
async function ignoredByRepository(repository: string, absolute: string) {
  const relative = path.relative(repository, absolute).replace(/\\/gu, "/");
  const directory = (await fs.stat(absolute).catch(() => null))?.isDirectory() ?? false;
  try {
    await gitProcesses.run({ args: ["check-ignore", "-q", "--", directory ? `${relative}/` : relative], cwd: repository });
    return true;
  } catch (error) {
    if (error instanceof GitProcessError && error.code === 1) return false;
    throw error;
  }
}

/**
 * Scratch needs no claims; filesystem roots, Workbench data, Git internals and paths another repository does not
 * ignore are never machine arc scope.
 */
export async function machineArcPathRejection(absolute: string, machineRoot: string) {
  const resolved = path.resolve(absolute);
  if (filesystemRoot(resolved) === resolved || comparable(resolved) === comparable(machineRoot)) {
    return `${resolved} is a filesystem root; claim specific files or folders.`;
  }
  if (isDaemonWorkspacePath(resolved)) return `${resolved} is daemon scratch; scratch files need no claims.`;
  if (isPathWithinRoot(resolved, resolveWorkbenchDataRoot())) return `${resolved} is Workbench data; it cannot be claimed.`;
  if (resolved.split(/[\\/]/u).includes(".git")) return `${resolved} is Git repository internals; it cannot be claimed.`;
  const repository = await containingRepository(resolved, machineRoot);
  if (repository && !await ignoredByRepository(repository, resolved)) {
    return `${resolved} is visible to the Git repository at ${repository}; that project's arcs own it.`;
  }
  return null;
}

export function machineArcDisplayPath(root: MachineGitArcRoot, relative: string) {
  return path.resolve(root.root, relative).replace(/\\/gu, "/");
}
