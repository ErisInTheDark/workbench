/*
 * Exports:
 * - runtime/dynamic: force the VS Code launcher route onto Node.js without static caching. Keywords: file open, VS Code, route.
 * - POST: open a project-relative file in VS Code through the local `code --goto` CLI. Keywords: file open, VS Code, goto.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectFilePath, resolveProjectRoot } from "../../../../lib/project";
import type { OpenFileInEditorRequest, OpenFileInEditorResponse } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveInteger(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.trunc(numericValue)
    : null;
}

function normalizeOpenFileRequest(value: unknown): OpenFileInEditorRequest | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) {
    return null;
  }

  return {
    columnNumber: normalizePositiveInteger(value.columnNumber),
    lineNumber: normalizePositiveInteger(value.lineNumber),
    path: value.path,
    projectId: typeof value.projectId === "string" ? value.projectId : null,
  };
}

function createGotoTarget(absolutePath: string, lineNumber: number | null, columnNumber: number | null) {
  if (lineNumber === null) {
    return absolutePath;
  }

  return `${absolutePath}:${lineNumber}${columnNumber === null ? "" : `:${columnNumber}`}`;
}

function quoteWindowsCommandPart(part: string) {
  if (!part.length) {
    return "\"\"";
  }

  if (!/[\s"]/u.test(part)) {
    return part;
  }

  return `"${part.replace(/"/g, "\\\"")}"`;
}

function createCodeSpawnDescriptor(target: string) {
  const codeCommand = "code";
  const codeArgs = ["--goto", target];
  if (process.platform !== "win32") {
    return {
      args: codeArgs,
      command: codeCommand,
      detached: true,
    };
  }

  return {
    args: [
      "/d",
      "/s",
      "/c",
      [codeCommand, ...codeArgs].map((part) => quoteWindowsCommandPart(part)).join(" "),
    ],
    command: process.env.ComSpec ?? "cmd.exe",
    detached: false,
  };
}

async function openInVsCode(target: string) {
  await new Promise<void>((resolve, reject) => {
    const spawnDescriptor = createCodeSpawnDescriptor(target);
    const child = spawn(spawnDescriptor.command, spawnDescriptor.args, {
      detached: spawnDescriptor.detached,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function POST(request: NextRequest) {
  try {
    const payload = normalizeOpenFileRequest(await request.json().catch(() => null));
    if (!payload) {
      return NextResponse.json({ error: "A project file path is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(payload.projectId);
    const resolvedFile = resolveProjectFilePath(resolvedProject, payload.path);
    const absolutePath = resolvedFile.absolutePath;
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return NextResponse.json({ error: "The requested path is not a file." }, { status: 400 });
    }

    const normalizedPath = resolvedFile.displayPath;
    const target = createGotoTarget(absolutePath, payload.lineNumber ?? null, payload.columnNumber ?? null);
    await openInVsCode(target);

    return NextResponse.json({
      ok: true,
      path: normalizedPath,
      projectId: resolvedProject.id,
      target,
    } satisfies OpenFileInEditorResponse, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to open file in VS Code.",
    }, { status: 400 });
  }
}
