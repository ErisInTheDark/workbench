import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { getHeadFileContent } from "../../../lib/git";
import { getProjectSnapshot, resolveProjectFilePath, resolveProjectRoot } from "../../../lib/project";
import { isWorkbenchOpenableFile } from "../../../lib/workbench/project/tree-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const relativePath = request.nextUrl.searchParams.get("path");
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!relativePath) {
    return NextResponse.json({ error: "A file path is required." }, { status: 400 });
  }

  try {
    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = resolveProjectFilePath(resolvedProject, relativePath);
    const absolutePath = resolvedFile.absolutePath;
    const stats = await fs.stat(absolutePath);
    const normalizedPath = resolvedFile.displayPath;

    if (!isWorkbenchOpenableFile(resolvedFile.rootRelativePath)) {
      return NextResponse.json({ error: "Only markdown files can be opened in the workbench." }, { status: 400 });
    }

    if (!stats.isFile()) {
      return NextResponse.json({ error: "The requested path is not a file." }, { status: 400 });
    }

    const [content, headContent] = await Promise.all([
      fs.readFile(absolutePath, "utf8"),
      getHeadFileContent(resolvedFile.gitRoot, resolvedFile.rootRelativePath),
    ]);

    return NextResponse.json({
      path: normalizedPath,
      projectId: resolvedProject.id,
      content,
      headContent,
      updatedAt: stats.mtime.toISOString(),
      mtimeMs: Math.trunc(stats.mtimeMs),
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const {
      path: relativePath,
      projectId,
      content,
      expectedMtimeMs,
      force = false,
      resetToHead = false,
    } = await request.json();

    if (!relativePath) {
      return NextResponse.json({ error: "A file path is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(projectId);
    const resolvedFile = resolveProjectFilePath(resolvedProject, relativePath);
    const absolutePath = resolvedFile.absolutePath;
    const statsBeforeWrite = await fs.stat(absolutePath);
    const actualMtimeMs = Math.trunc(statsBeforeWrite.mtimeMs);
    const normalizedPath = resolvedFile.displayPath;

    if (!isWorkbenchOpenableFile(resolvedFile.rootRelativePath)) {
      return NextResponse.json({ error: "Only markdown files can be edited in the workbench." }, { status: 400 });
    }

    if (!statsBeforeWrite.isFile()) {
      return NextResponse.json({ error: "The requested path is not a file." }, { status: 400 });
    }

    if (!resetToHead && typeof content !== "string") {
      return NextResponse.json({ error: "A file path and utf-8 content are required." }, { status: 400 });
    }

    if (!force && !Number.isFinite(expectedMtimeMs)) {
      return NextResponse.json({ error: `An expected file mtime is required to ${resetToHead ? "reset" : "save"}.` }, { status: 400 });
    }

    if (!force && actualMtimeMs !== Math.trunc(expectedMtimeMs)) {
      return NextResponse.json({
        error: "This file changed on disk after it was opened.",
        path: normalizedPath,
        expectedUpdatedAt: new Date(expectedMtimeMs).toISOString(),
        expectedMtimeMs: Math.trunc(expectedMtimeMs),
        actualUpdatedAt: statsBeforeWrite.mtime.toISOString(),
        actualMtimeMs,
      }, {
        status: 409,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const nextContent = resetToHead
      ? await getHeadFileContent(resolvedFile.gitRoot, resolvedFile.rootRelativePath)
      : content;

    if (resetToHead && nextContent === null) {
      return NextResponse.json({
        error: "This file does not have a HEAD version to reset to.",
      }, {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    await fs.writeFile(absolutePath, nextContent, "utf8");

    const [snapshot, stats] = await Promise.all([
      getProjectSnapshot(resolvedProject.id),
      fs.stat(absolutePath),
    ]);

    return NextResponse.json({
      path: normalizedPath,
      projectId: resolvedProject.id,
      updatedAt: stats.mtime.toISOString(),
      mtimeMs: Math.trunc(stats.mtimeMs),
      changes: snapshot.changes,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
