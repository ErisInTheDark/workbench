/*
 * Exports:
 * - No production exports; Node tests verify external aliases remain selectable while indirect duplicates collapse onto directly discovered Git roots. Keywords: project, discovery, duplicate, junction, symlink, realpath, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function normalizePath(filePath: string) {
  return filePath.replace(/\\/gu, "/");
}

test("preserves external Git aliases while suppressing indirect duplicates of direct roots", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-junction-"));
  const projectsRoot = path.join(temporaryRoot, "projects");
  const configuredProjectsRoot = path.join(temporaryRoot, "projects-link");
  const canonicalProjectRoot = path.join(temporaryRoot, "external", "canonical-target");
  const linkedProjectRoot = path.join(projectsRoot, "manyworld");
  const directProjectRoot = path.join(projectsRoot, "stories", "notekeeper+kaia");
  const indirectProjectRoot = path.join(projectsRoot, ".machine-cache", "v3", "projects", "opaque-hash");
  const workbenchLibraryRoot = path.join(temporaryRoot, "library");
  const originalProjectsRoot = process.env.WORKBENCH_PROJECTS_ROOT;
  const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;

  context.after(async () => {
    if (originalProjectsRoot === undefined) {
      delete process.env.WORKBENCH_PROJECTS_ROOT;
    } else {
      process.env.WORKBENCH_PROJECTS_ROOT = originalProjectsRoot;
    }
    if (originalWorkbenchLibraryRoot === undefined) {
      delete process.env.WORKBENCH_LIBRARY_ROOT;
    } else {
      process.env.WORKBENCH_LIBRARY_ROOT = originalWorkbenchLibraryRoot;
    }
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  await fs.mkdir(path.join(canonicalProjectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(directProjectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.dirname(indirectProjectRoot), { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.writeFile(path.join(canonicalProjectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(path.join(directProjectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(
    path.join(projectsRoot, "manyworld.code-workspace"),
    JSON.stringify({ folders: [{ path: "manyworld" }] }),
    "utf8",
  );
  await fs.symlink(canonicalProjectRoot, linkedProjectRoot, process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(directProjectRoot, indirectProjectRoot, process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(projectsRoot, configuredProjectsRoot, process.platform === "win32" ? "junction" : "dir");

  process.env.WORKBENCH_PROJECTS_ROOT = configuredProjectsRoot;
  process.env.WORKBENCH_LIBRARY_ROOT = workbenchLibraryRoot;
  const { discoverProjects, resolveDiscoveredProject, resolveProjectRoot } = await import("./project");
  const { resolveAgentEndpointProjectFromProjects } = await import("./workbench/project/agent-endpoint-project");
  const canonicalRootPath = normalizePath(await fs.realpath(canonicalProjectRoot));
  const projects = await discoverProjects();

  const gitProject = projects.find((project) => project.kind === "git" && project.id === "manyworld");
  assert.ok(gitProject);
  assert.equal(gitProject.name, "manyworld");
  assert.equal(gitProject.relativePath, "manyworld");
  assert.equal(gitProject.rootPath, canonicalRootPath);
  assert.equal(gitProject.roots[0]?.relativePath, "manyworld");
  assert.equal(gitProject.roots[0]?.rootPath, canonicalRootPath);

  const resolvedCatalogProject = await resolveDiscoveredProject(gitProject);
  assert.equal(normalizePath(resolvedCatalogProject.root), canonicalRootPath);
  assert.equal(resolvedCatalogProject.roots[0]?.name, "manyworld");
  assert.equal(resolvedCatalogProject.roots[0]?.relativePath, "manyworld");

  const resolvedGitProject = await resolveProjectRoot(gitProject.id);
  assert.equal(normalizePath(resolvedGitProject.root), canonicalRootPath);

  const workspaceProject = projects.find((project) => project.kind === "workspace" && project.id === "manyworld.code-workspace");
  assert.ok(workspaceProject);
  assert.equal(workspaceProject.roots[0]?.relativePath, "manyworld");
  assert.equal(workspaceProject.roots[0]?.rootPath, canonicalRootPath);

  const resolvedWorkspaceProject = await resolveDiscoveredProject(workspaceProject);
  assert.equal(normalizePath(resolvedWorkspaceProject.root), canonicalRootPath);
  assert.equal(normalizePath(resolvedWorkspaceProject.roots[0]?.root ?? ""), canonicalRootPath);

  const directProject = projects.find((project) => project.kind === "git" && project.id === "stories/notekeeper+kaia");
  assert.ok(directProject);
  assert.equal(normalizePath(directProject.rootPath), normalizePath(await fs.realpath(directProjectRoot)));
  assert.equal(
    projects.some((project) => project.kind === "git" && project.id === ".machine-cache/v3/projects/opaque-hash"),
    false,
  );

  const agentProject = await resolveAgentEndpointProjectFromProjects(projects, indirectProjectRoot);
  assert.equal(agentProject.project.id, directProject.id);
  assert.equal(normalizePath(agentProject.project.rootPath), normalizePath(await fs.realpath(directProjectRoot)));
});
