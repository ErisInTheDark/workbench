/*
 * Exports:
 * - AgentEndpointProjectResolution: resolved cwd, Workbench project, and owning root for a project-scoped agent endpoint. Keywords: agent endpoint, cwd, project.
 * - resolveAgentEndpointProjectFromCwd: resolve a project-scoped agent endpoint request from cwd without relying on route process memory. Keywords: agent endpoint, cwd, serverless.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  discoverProjects,
  normalizeRelativePath,
  resolveProjectRoot,
  type ResolvedProject,
} from "../../project";
import type { WorkbenchProjectOption } from "../../types";

export interface AgentEndpointProjectResolution {
  cwd: string;
  project: ResolvedProject;
  root: ResolvedProject["roots"][number];
}

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
  } catch {
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
  const matches: Array<{ projectId: string; rootPath: string }> = [];
  for (const project of projects) {
    for (const root of project.roots) {
      if (await isCwdWithinRoot(cwd, root.rootPath)) {
        matches.push({
          projectId: project.id,
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

export async function resolveAgentEndpointProjectFromCwd(
  cwd: string | null | undefined,
  { endpointName = "Agent endpoint" }: { endpointName?: string } = {},
): Promise<AgentEndpointProjectResolution> {
  const requestedCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!requestedCwd) {
    throw new Error(`${endpointName} requires a cwd.`);
  }

  const resolvedCwd = path.resolve(requestedCwd);
  const projectMatch = await findProjectMatchForCwd(await discoverProjects(), resolvedCwd);
  if (!projectMatch) {
    throw new Error(`${endpointName} cwd must be inside a discovered Workbench project.`);
  }

  const project = await resolveProjectRoot(projectMatch.projectId);
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
