import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { getGitChanges } from "../../../lib/git";
import { normalizeRelativePath, projectRoot, safeResolve } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const relativePath = request.nextUrl.searchParams.get("path");
  if (!relativePath) {
    return NextResponse.json({ error: "A file path is required." }, { status: 400 });
  }

  try {
    const absolutePath = safeResolve(relativePath);
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      return NextResponse.json({ error: "The requested path is not a file." }, { status: 400 });
    }

    const content = await fs.readFile(absolutePath, "utf8");
    return NextResponse.json({
      path: normalizeRelativePath(relativePath),
      content,
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
      content,
      expectedMtimeMs,
      force = false,
    } = await request.json();

    if (!relativePath || typeof content !== "string") {
      return NextResponse.json({ error: "A file path and utf-8 content are required." }, { status: 400 });
    }

    const absolutePath = safeResolve(relativePath);
    const statsBeforeWrite = await fs.stat(absolutePath);
    const actualMtimeMs = Math.trunc(statsBeforeWrite.mtimeMs);

    if (!statsBeforeWrite.isFile()) {
      return NextResponse.json({ error: "The requested path is not a file." }, { status: 400 });
    }

    if (!force && !Number.isFinite(expectedMtimeMs)) {
      return NextResponse.json({ error: "An expected file mtime is required to save." }, { status: 400 });
    }

    if (!force && actualMtimeMs !== Math.trunc(expectedMtimeMs)) {
      return NextResponse.json({
        error: "This file changed on disk after it was opened.",
        path: normalizeRelativePath(relativePath),
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

    await fs.writeFile(absolutePath, content, "utf8");

    const [changes, stats] = await Promise.all([
      getGitChanges(projectRoot),
      fs.stat(absolutePath),
    ]);

    return NextResponse.json({
      path: normalizeRelativePath(relativePath),
      updatedAt: stats.mtime.toISOString(),
      mtimeMs: Math.trunc(stats.mtimeMs),
      changes,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
