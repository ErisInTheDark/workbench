/*
 * Exports:
 * - runtime/dynamic: keep native file-manager launching on the dynamic Node.js runtime. Keywords: file manager, reveal, route.
 * - POST: reveal a validated project file or directory in the platform-native file manager. Keywords: explorer, Finder, xdg-open, project path.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectFilePath, resolveProjectRoot } from "../../../../lib/project";
import type { RevealProjectEntryRequest, RevealProjectEntryResponse } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function createFileManagerCommand(absolutePath: string, isDirectory: boolean) {
  if (process.platform === "win32") {
    return {
      args: isDirectory ? [absolutePath] : [`/select,${absolutePath}`],
      command: "explorer.exe",
    };
  }
  if (process.platform === "darwin") {
    return {
      args: isDirectory ? [absolutePath] : ["-R", absolutePath],
      command: "open",
    };
  }

  return {
    args: [isDirectory ? absolutePath : path.dirname(absolutePath)],
    command: "xdg-open",
  };
}

async function revealInFileManager(absolutePath: string, isDirectory: boolean) {
  const descriptor = createFileManagerCommand(absolutePath, isDirectory);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(descriptor.command, descriptor.args, {
      detached: process.platform !== "win32",
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
    const value = await request.json().catch(() => null) as Partial<RevealProjectEntryRequest> | null;
    if (!value?.path) {
      return NextResponse.json({ error: "A project path is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(value.projectId);
    const resolvedEntry = resolveProjectFilePath(resolvedProject, value.path);
    const stats = await fs.stat(resolvedEntry.absolutePath);
    await revealInFileManager(resolvedEntry.absolutePath, stats.isDirectory());

    return NextResponse.json({
      ok: true,
      path: resolvedEntry.displayPath,
      projectId: resolvedProject.id,
    } satisfies RevealProjectEntryResponse, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to reveal project entry.",
    }, { status: 400 });
  }
}
