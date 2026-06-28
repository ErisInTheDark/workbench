/*
 * Exports:
 * - runtime/dynamic: force collaboration scratchpad reads and writes onto Node.js without static caching. Keywords: collaboration, scratchpad, node.
 * - GET/PUT: ensure, read, autosave, and keep-everything merge the project Collaboration scratchpad. Keywords: collaboration, scratchpad, markdown, autosave.
 */

import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import {
  mergeCollaborationScratchpadContent,
  normalizeCollaborationScratchpadContent,
  type CollaborationScratchpadFile,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad";
import {
  createWorkbenchCollaborationScratchpadRelativePath,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad-path";
import { getProjectSnapshot, resolveProjectRoot } from "../../../../lib/project";
import { isMarkdownFile } from "../../../../lib/workbench/project/tree-utils";
import {
  cleanupStaleScratchpadImageAssets,
  ensureScratchpadFile,
  getCollaborationScratchpadRequestPath,
  resolveCollaborationScratchpadFile,
  touchReferencedScratchpadImageAssets,
  type ResolvedScratchpadFile,
} from "./scratchpad-file-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRequestPath(request: NextRequest, projectId: string) {
  return getCollaborationScratchpadRequestPath(request.nextUrl.searchParams.get("path"), projectId);
}

async function readScratchpadPayload(scratchpadFile: ResolvedScratchpadFile): Promise<CollaborationScratchpadFile> {
  const [content, stats] = await Promise.all([
    fs.readFile(scratchpadFile.absolutePath, "utf8"),
    fs.stat(scratchpadFile.absolutePath),
  ]);
  const normalizedContent = normalizeCollaborationScratchpadContent(content, "user");
  await touchReferencedScratchpadImageAssets(scratchpadFile, normalizedContent);

  return {
    content: normalizedContent,
    headContent: null,
    mtimeMs: Math.trunc(stats.mtimeMs),
    path: scratchpadFile.displayPath,
    projectId: scratchpadFile.projectId,
    updatedAt: stats.mtime.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = await resolveCollaborationScratchpadFile(resolvedProject.id, getRequestPath(request, resolvedProject.id));
    if (!isMarkdownFile(resolvedFile.rootRelativePath)) {
      return NextResponse.json({ error: "The collaboration scratchpad must be a markdown file." }, { status: 400 });
    }

    await ensureScratchpadFile(resolvedFile.absolutePath);
    return NextResponse.json(await readScratchpadPayload(resolvedFile), {
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
    const resolvedFile = await resolveCollaborationScratchpadFile(resolvedProject.id, typeof requestPath === "string" && requestPath.trim()
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
    await touchReferencedScratchpadImageAssets(resolvedFile, mergedContent);
    await cleanupStaleScratchpadImageAssets(resolvedFile, mergedContent);
    const [payload, snapshot] = await Promise.all([
      readScratchpadPayload(resolvedFile),
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
