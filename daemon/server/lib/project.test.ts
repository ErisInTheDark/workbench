/*
 * Exports:
 * - No production exports; tests protect canonical checkout filtering, external aliases, and clone exclusion.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(...args: string[]) {
  return await execFileAsync("git", args, { windowsHide: true, encoding: "utf8" });
}

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

  await fs.mkdir(canonicalProjectRoot, { recursive: true });
  await fs.mkdir(directProjectRoot, { recursive: true });
  await git("init", "--quiet", canonicalProjectRoot);
  await git("init", "--quiet", directProjectRoot);
  await git("-C", directProjectRoot, "config", "remote.origin.url", "https://example.test/stories/notekeeper.git");
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
  const { discoverProjectIdentities, discoverProjects, resolveDiscoveredProject, resolveProjectRoot } = await import("./project");
  const { resolveAgentEndpointProjectFromProjects } = await import("./workbench/project/agent-endpoint-project");
  const canonicalRootPath = normalizePath(await fs.realpath(canonicalProjectRoot));
  const projects = await discoverProjects();

  const gitProject = projects.find((project) => project.kind === "git" && project.relativePath === "manyworld");
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

  const workspaceProject = projects.find((project) => project.kind === "workspace" && project.relativePath === "manyworld.code-workspace");
  assert.ok(workspaceProject);
  assert.equal(workspaceProject.roots[0]?.relativePath, "manyworld");
  assert.equal(workspaceProject.roots[0]?.rootPath, canonicalRootPath);

  const resolvedWorkspaceProject = await resolveDiscoveredProject(workspaceProject);
  assert.equal(normalizePath(resolvedWorkspaceProject.root), canonicalRootPath);
  assert.equal(normalizePath(resolvedWorkspaceProject.roots[0]?.root ?? ""), canonicalRootPath);

  const directProject = projects.find((project) => project.kind === "git" && project.relativePath === "stories/notekeeper+kaia");
  assert.ok(directProject);
  assert.equal(normalizePath(directProject.rootPath), normalizePath(await fs.realpath(directProjectRoot)));
  assert.equal(
    projects.some((project) => project.kind === "git" && project.relativePath === ".machine-cache/v3/projects/opaque-hash"),
    false,
  );

  const agentProject = await resolveAgentEndpointProjectFromProjects(projects, indirectProjectRoot);
  assert.equal(agentProject.project.id, directProject.id);
  assert.equal(normalizePath(agentProject.project.rootPath), normalizePath(await fs.realpath(directProjectRoot)));

  const identified = await discoverProjectIdentities();
  assert.equal(identified.data.filter(project => project.kind === "git" && project.rootPath === directProject.rootPath).length, 1);
  assert.ok(identified.data.some(project => project.kind === "git" && project.rootPath === canonicalRootPath));
  const identifiedDirect = identified.data.find(project => project.kind === "git" && project.rootPath === directProject.rootPath)!;
  assert.equal(identifiedDirect.id, directProject.id);
  assert.deepEqual(identified.aliases.find(alias => alias.alias === directProject.relativePath), {
    alias: directProject.relativePath, projectId: identifiedDirect.id,
  });

  await fs.writeFile(path.join(projectsRoot, "incomplete.code-workspace"), JSON.stringify({
    folders: [{ path: "manyworld" }, { path: "missing-member" }],
  }));
  const incompleteWarnings: string[] = [];
  const incompleteWarning = context.mock.method(console, "warn", (message: string) => incompleteWarnings.push(message));
  const incomplete = await discoverProjectIdentities();
  incompleteWarning.mock.restore();
  assert.ok(!incomplete.data.some(project => project.relativePath === "incomplete.code-workspace"),
    "a missing member must not give a workspace the identity of a smaller set");
  assert.ok(incompleteWarnings.length > 0);
  await fs.unlink(path.join(projectsRoot, "incomplete.code-workspace"));

  const cloneRoot = path.join(projectsRoot, "ordinary-clone");
  await fs.mkdir(cloneRoot);
  await git("init", "--quiet", cloneRoot);
  await git("-C", cloneRoot, "config", "remote.origin.url", "git@example.test:stories/notekeeper.git");
  const warnings: string[] = [];
  const warning = context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const ambiguous = await discoverProjectIdentities();
  assert.equal(warnings.length, 1);
  assert.ok(!ambiguous.data.some(project => project.rootPath === directProject.rootPath || project.rootPath === normalizePath(cloneRoot)));
  assert.ok(ambiguous.data.some(project => project.rootPath === canonicalRootPath));

  await git("-C", canonicalProjectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const linkedWorktree = path.join(canonicalProjectRoot, "linked-worktree");
  await git("-C", canonicalProjectRoot, "worktree", "add", "--quiet", "--detach", linkedWorktree);
  await fs.writeFile(path.join(projectsRoot, "linked.code-workspace"), JSON.stringify({ folders: [{ path: linkedWorktree }] }));
  const withoutWorktrees = await discoverProjectIdentities();
  assert.ok(!withoutWorktrees.data.some(project => project.relativePath === "linked.code-workspace"));
  assert.ok(withoutWorktrees.excludedRootPaths.includes(normalizePath(linkedWorktree)));
  await assert.rejects(
    resolveAgentEndpointProjectFromProjects(identified.data, linkedWorktree),
    /worktree|excluded/i,
  );
  warning.mock.restore();
});
