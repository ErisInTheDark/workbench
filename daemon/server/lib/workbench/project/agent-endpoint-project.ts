/*
 * Exports:
 * - AgentEndpointProjectResolution: validated cwd, project, and owning root.
 * - resolveAgentEndpointProjectFromProjects: resolve cwd against a supplied catalogue without admitting excluded checkouts;
 *   an owner project breaks ties between projects sharing the deepest matching root.
 * - AgentEndpointProjectResolverOptions: endpoint label and the thread whose project wins shared-root ties.
 * - AgentEndpointProjectResolver: catalogue-owned cwd resolution port.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { resolveDiscoveredProject, type ResolvedProject } from "../../project";
import { normalizeRelativePath } from "../../project-paths";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { isLinkedGitWorktree, resolveGitDirectory } from "../../git";

export interface AgentEndpointProjectResolution {
  cwd: string;
  project: ResolvedProject;
  root: ResolvedProject["roots"][number];
}

export interface AgentEndpointProjectResolverOptions {
  endpointName?: string;
  /** The thread acting at cwd; its project wins when several projects share the deepest root containing cwd. */
  ownerThreadId?: string | null;
}

export type AgentEndpointProjectResolver = (
  cwd: string | null | undefined,
  options?: AgentEndpointProjectResolverOptions,
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

async function findProjectMatchForCwd(
  projects: readonly WorkbenchProjectOption[],
  cwd: string,
  ownerProjectId: (() => Promise<ProjectId | null>) | undefined,
) {
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

  const [deepest, ...rest] = matches.sort((left, right) => right.rootPath.length - left.rootPath.length);
  if (!deepest) return null;
  const tied = rest.filter(match => match.rootPath.length === deepest.rootPath.length);
  if (!tied.length || !ownerProjectId) return deepest;
  const owner = await ownerProjectId();
  return [deepest, ...tied].find(match => match.project.id === owner) ?? deepest;
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
  { endpointName = "Agent endpoint", excludedRootPaths = [], ownerProjectId }: {
    endpointName?: string;
    excludedRootPaths?: readonly string[];
    /** Read only when projects tie on the deepest root, so unambiguous resolutions never look up the owner. */
    ownerProjectId?: () => Promise<ProjectId | null>;
  } = {},
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
  const projectMatch = await findProjectMatchForCwd(projects, resolvedCwd, ownerProjectId);
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
