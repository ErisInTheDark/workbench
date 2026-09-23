/*
 * Exports:
 * - AgentEndpointProjectResolution: validated cwd, project, and owning root.
 * - resolveAgentEndpointProjectFromProjects: resolve cwd against a supplied catalogue without admitting excluded checkouts.
 * - AgentEndpointProjectResolver: catalogue-owned cwd resolution port.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeRelativePath,
  resolveDiscoveredProject,
  type ResolvedProject,
} from "../../project";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { isLinkedGitWorktree, resolveGitDirectory } from "../../git";

export interface AgentEndpointProjectResolution {
  cwd: string;
  project: ResolvedProject;
  root: ResolvedProject["roots"][number];
}

export type AgentEndpointProjectResolver = (
  cwd: string | null | undefined,
  options?: { endpointName?: string },
) => Promise<AgentEndpointProjectResolution>;

function normalizeComparablePath(filePath: string) {
  const normalizedPath = normalizeRelativePath(path.resolve(filePath)).replace(/\/+$/u, "");
  return process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

async function readComparablePathVariants(filePath: string) {
  const variants = new Set<string>([normalizeComparablePath(filePath)]);
  try {
    variants.add(normalizeComparablePath(await fs.realpath(filePath)));
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Missing paths can still produce a useful resolved-path comparison; callers own existence checks.
  }
  return variants;
}

function hasContainedPath(candidatePaths: ReadonlySet<string>, rootPaths: ReadonlySet<string>) {
  for (const candidatePath of candidatePaths) {
    for (const rootPath of rootPaths) {
      if (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`)) {
        return true;
      }
    }
  }
  return false;
}

async function isCwdWithinRoot(cwd: string, rootPath: string) {
  return hasContainedPath(
    await readComparablePathVariants(cwd),
    await readComparablePathVariants(rootPath),
  );
}

async function findProjectMatchForCwd(projects: readonly WorkbenchProjectOption[], cwd: string) {
  const matches: Array<{ project: WorkbenchProjectOption; rootPath: string }> = [];
  for (const project of projects) {
    for (const root of project.roots) {
      if (await isCwdWithinRoot(cwd, root.rootPath)) {
        matches.push({
          project,
          rootPath: path.resolve(root.rootPath),
        });
      }
    }
  }

  return matches.sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
}

async function findOwningResolvedRoot(project: ResolvedProject, cwd: string) {
  for (const root of project.roots) {
    if (await isCwdWithinRoot(cwd, root.root)) {
      return root;
    }
  }
  return null;
}

export async function resolveAgentEndpointProjectFromProjects(
  projects: readonly WorkbenchProjectOption[],
  cwd: string | null | undefined,
  { endpointName = "Agent endpoint", excludedRootPaths = [] }: { endpointName?: string; excludedRootPaths?: readonly string[] } = {},
): Promise<AgentEndpointProjectResolution> {
  const requestedCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!requestedCwd) {
    throw new Error(`${endpointName} requires a cwd.`);
  }

  const resolvedCwd = path.resolve(requestedCwd);
  if (!(await fs.stat(resolvedCwd)).isDirectory()) throw new Error(`${endpointName} cwd must be a directory.`);
  for (const excludedRoot of excludedRootPaths) {
    if (await isCwdWithinRoot(resolvedCwd, excludedRoot)) throw new Error(`${endpointName} cwd belongs to an excluded checkout.`);
  }
  let ancestor = await fs.realpath(resolvedCwd);
  let linkedRoot: string | null = null;
  while (true) {
    if (await resolveGitDirectory(ancestor)) {
      if (await isLinkedGitWorktree(ancestor)) linkedRoot = ancestor;
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const projectMatch = await findProjectMatchForCwd(projects, resolvedCwd);
  if (!projectMatch) {
    throw new Error(`${endpointName} cwd must be inside a discovered Workbench project.`);
  }
  if (linkedRoot && !projectMatch.project.roots.some(root =>
    normalizeComparablePath(root.rootPath) === normalizeComparablePath(linkedRoot))) {
    throw new Error(`${endpointName} cwd belongs to an unregistered project location.`);
  }

  const project = await resolveDiscoveredProject(projectMatch.project);
  const root = await findOwningResolvedRoot(project, resolvedCwd);
  if (!root) {
    throw new Error(`${endpointName} cwd must be inside the resolved Workbench project.`);
  }

  return {
    cwd: resolvedCwd,
    project,
    root,
  };
}
