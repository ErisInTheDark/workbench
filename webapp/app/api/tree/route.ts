/*
 * Exports:
 * - runtime/dynamic: keep project tree transport on the dynamic Node.js runtime. Keywords: tree, api, node runtime, stateless.
 * - GET: stream an orchestrator-owned serialized project snapshot, with a stateless local fallback for pre-bootstrap orchestrators. Keywords: tree, project, orchestrator, proxy.
 * - POST: create a project entry through the orchestrator, with a stateless local fallback for pre-bootstrap orchestrators. Keywords: tree, create, orchestrator, compatibility.
 * - DELETE: permanently delete a project file through the orchestrator after enforcing tracked-file confirmation semantics. Keywords: tree, delete, git, confirmation.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function localTreeGetFallback(request: NextRequest) {
  const { getProjectSnapshot } = await import("../../../lib/project");
  try {
    return NextResponse.json(await getProjectSnapshot(request.nextUrl.searchParams.get("projectId")), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load project." }, { status: 400 });
  }
}

async function localTreePostFallback(request: Request) {
  const {
    createProjectEntry,
    formatWorkspaceQualifiedPath,
    getProjectSnapshot,
    resolveProjectFilePath,
    resolveProjectRoot,
  } = await import("../../../lib/project");
  try {
    const { parentPath = "", projectId, name, type } = await request.json() as {
      name?: string;
      parentPath?: string;
      projectId?: string;
      type?: string;
    };
    if (type !== "file" && type !== "directory") {
      return NextResponse.json({ error: "A valid entry type is required." }, { status: 400 });
    }
    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedParent = resolveProjectFilePath(resolvedProject, parentPath);
    const createdRootPath = await createProjectEntry(resolvedParent.rootRelativePath, name ?? "", type, resolvedParent.gitRoot);
    const createdPath = resolvedProject.kind === "workspace"
      ? formatWorkspaceQualifiedPath(resolvedParent.root.id, createdRootPath)
      : createdRootPath;
    return NextResponse.json({
      ...await getProjectSnapshot(resolvedProject.id),
      path: createdPath,
      type,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create project entry." }, { status: 400 });
  }
}

async function localTreeDeleteFallback(request: Request) {
  const {
    assertProjectFileCanBeDeleted,
    deleteProjectFile,
    getProjectSnapshot,
    resolveProjectFilePath,
    resolveProjectRoot,
  } = await import("../../../lib/project");
  const { isGitTrackedFile } = await import("../../../lib/git");
  try {
    const { confirmUntracked = false, path, projectId } = await request.json() as {
      confirmUntracked?: boolean;
      path?: string;
      projectId?: string;
    };
    if (!path) {
      return NextResponse.json({ error: "A file path is required." }, { status: 400 });
    }
    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = resolveProjectFilePath(resolvedProject, path);
    await assertProjectFileCanBeDeleted(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
    const tracked = await isGitTrackedFile(resolvedFile.gitRoot, resolvedFile.rootRelativePath);
    if (!tracked && !confirmUntracked) {
      return NextResponse.json({
        confirmationRequired: true,
        path: resolvedFile.displayPath,
        projectId: resolvedProject.id,
        tracked: false,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    await deleteProjectFile(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
    return NextResponse.json({
      ...await getProjectSnapshot(resolvedProject.id),
      path: resolvedFile.displayPath,
      tracked,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete project file." }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const response = await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/tree", {
    responseMode: "stream",
    timeoutMs: 10_000,
  });
  if (response.status !== 404) return response;
  await response.arrayBuffer();
  return await localTreeGetFallback(request);
}

export async function POST(request: NextRequest) {
  const fallbackRequest = request.clone();
  const response = await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/tree", {
    responseMode: "stream",
    timeoutMs: 10_000,
  });
  if (response.status !== 404) return response;
  await response.arrayBuffer();
  return await localTreePostFallback(fallbackRequest);
}

export async function DELETE(request: NextRequest) {
  const fallbackRequest = request.clone();
  const response = await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/tree", {
    responseMode: "stream",
    timeoutMs: 10_000,
  });
  if (response.status !== 404) return response;
  await response.arrayBuffer();
  return await localTreeDeleteFallback(fallbackRequest);
}
