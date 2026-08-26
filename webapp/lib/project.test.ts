/*
 * Exports:
 * - No production exports; Node tests verify linked project aliases resolve to canonical Git and workspace roots. Keywords: project, discovery, junction, symlink, realpath, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function normalizePath(filePath: string) {
  return filePath.replace(/\\/gu, "/");
}

test("discovers a linked Git project by alias and resolves canonical harness roots", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-junction-"));
  const projectsRoot = path.join(temporaryRoot, "projects");
  const canonicalProjectRoot = path.join(temporaryRoot, "external", "canonical-target");
  const linkedProjectRoot = path.join(projectsRoot, "manyworld");
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
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.writeFile(path.join(canonicalProjectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(
    path.join(projectsRoot, "manyworld.code-workspace"),
    JSON.stringify({ folders: [{ path: "manyworld" }] }),
    "utf8",
  );
  await fs.symlink(canonicalProjectRoot, linkedProjectRoot, process.platform === "win32" ? "junction" : "dir");

  process.env.WORKBENCH_PROJECTS_ROOT = projectsRoot;
  process.env.WORKBENCH_LIBRARY_ROOT = workbenchLibraryRoot;
  const { discoverProjects, resolveDiscoveredProject, resolveProjectRoot } = await import("./project");
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
});
