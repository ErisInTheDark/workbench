/*
 * Exports:
 * - runtime/dynamic: force collaboration scratchpad reads and writes onto Node.js without static caching. Keywords: collaboration, scratchpad, node.
 * - GET/PUT: ensure, read, autosave, and keep-everything merge the project Collaboration scratchpad. Keywords: collaboration, scratchpad, markdown, autosave.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  createDefaultCollaborationScratchpadContent,
  mergeCollaborationScratchpadContent,
  normalizeCollaborationScratchpadContent,
  type CollaborationScratchpadFile,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad";
import {
  createWorkbenchCollaborationScratchpadRelativePath,
  isWorkbenchOwnedCollaborationScratchpadPath,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad-path";
import { getProjectSnapshot, projectRoot, resolveProjectFilePath, resolveProjectRoot } from "../../../../lib/project";
import { isMarkdownFile } from "../../../../lib/workbench/project/tree-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRequestPath(request: NextRequest, projectId: string) {
  return request.nextUrl.searchParams.get("path") || createWorkbenchCollaborationScratchpadRelativePath(projectId);
}

function resolveWorkbenchOwnedScratchpadFile(requestPath: string) {
  const normalizedPath = requestPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolutePath = path.resolve(projectRoot, normalizedPath);
  const normalizedProjectRoot = path.resolve(projectRoot);
  if (absolutePath !== normalizedProjectRoot && !absolutePath.startsWith(`${normalizedProjectRoot}${path.sep}`)) {
    throw new Error("Scratchpad path is outside Workbench storage.");
  }

  return {
    absolutePath,
    displayPath: normalizedPath,
    rootRelativePath: normalizedPath,
  };
}

function resolveScratchpadFile(resolvedProject: Awaited<ReturnType<typeof resolveProjectRoot>>, requestPath: string) {
  if (isWorkbenchOwnedCollaborationScratchpadPath(requestPath)) {
    return resolveWorkbenchOwnedScratchpadFile(requestPath);
  }

  try {
    return resolveProjectFilePath(resolvedProject, requestPath);
  } catch (error) {
    if (
      resolvedProject.kind === "workspace"
      && !requestPath.includes(":")
      && resolvedProject.roots[0]
    ) {
      return resolveProjectFilePath(resolvedProject, `${resolvedProject.roots[0].id}:${requestPath}`);
    }

    throw error;
  }
}

async function ensureScratchpadFile(absolutePath: string) {
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      throw new Error("The scratchpad path is not a file.");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, createDefaultCollaborationScratchpadContent(), "utf8");
}

async function readScratchpadPayload(projectId: string, displayPath: string, absolutePath: string): Promise<CollaborationScratchpadFile> {
  const [content, stats] = await Promise.all([
    fs.readFile(absolutePath, "utf8"),
    fs.stat(absolutePath),
  ]);

  return {
    content: normalizeCollaborationScratchpadContent(content, "user"),
    headContent: null,
    mtimeMs: Math.trunc(stats.mtimeMs),
    path: displayPath,
    projectId,
    updatedAt: stats.mtime.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = resolveScratchpadFile(resolvedProject, getRequestPath(request, resolvedProject.id));
    if (!isMarkdownFile(resolvedFile.rootRelativePath)) {
      return NextResponse.json({ error: "The collaboration scratchpad must be a markdown file." }, { status: 400 });
    }

    await ensureScratchpadFile(resolvedFile.absolutePath);
    return NextResponse.json(await readScratchpadPayload(
      resolvedProject.id,
      resolvedFile.displayPath,
      resolvedFile.absolutePath,
    ), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read the collaboration scratchpad." }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const {
      baseContent = null,
      content,
      path: requestPath,
      projectId,
    } = await request.json();
    if (typeof content !== "string") {
      return NextResponse.json({ error: "Scratchpad content is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = resolveScratchpadFile(resolvedProject, typeof requestPath === "string" && requestPath.trim()
      ? requestPath
      : createWorkbenchCollaborationScratchpadRelativePath(resolvedProject.id));
    if (!isMarkdownFile(resolvedFile.rootRelativePath)) {
      return NextResponse.json({ error: "The collaboration scratchpad must be a markdown file." }, { status: 400 });
    }

    await ensureScratchpadFile(resolvedFile.absolutePath);
    const latestDiskContent = await fs.readFile(resolvedFile.absolutePath, "utf8");
    const mergedContent = mergeCollaborationScratchpadContent({
      baseContent: typeof baseContent === "string" ? baseContent : null,
      currentContent: content,
      latestDiskContent,
    });
    await fs.writeFile(resolvedFile.absolutePath, mergedContent, "utf8");
    const [payload, snapshot] = await Promise.all([
      readScratchpadPayload(
        resolvedProject.id,
        resolvedFile.displayPath,
        resolvedFile.absolutePath,
      ),
      getProjectSnapshot(resolvedProject.id),
    ]);

    return NextResponse.json({
      ...payload,
      changes: snapshot.changes,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save the collaboration scratchpad." }, { status: 400 });
  }
}
