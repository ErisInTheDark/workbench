/*
 * Exports:
 * - runtime/dynamic: force external file-link root resolution onto Node.js without static caching. Keywords: file link, git root, external.
 * - POST: resolve absolute local file paths to nearest git roots for thread link display. Keywords: file link, absolute path, git root.
 */

import { NextRequest, NextResponse } from "next/server";

import { resolveExternalFileLinkRoot } from "../../../../lib/project";
import type { ResolveExternalFileLinkRootsRequest, ResolveExternalFileLinkRootsResponse } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RESOLVE_PATHS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRequest(value: unknown): ResolveExternalFileLinkRootsRequest | null {
  if (!isRecord(value) || !Array.isArray(value.paths)) {
    return null;
  }

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  for (const path of value.paths) {
    const normalizedPath = typeof path === "string" ? path.trim() : "";
    if (!normalizedPath || seenPaths.has(normalizedPath)) {
      continue;
    }

    seenPaths.add(normalizedPath);
    paths.push(normalizedPath);
    if (paths.length >= MAX_RESOLVE_PATHS) {
      break;
    }
  }

  return { paths };
}

export async function POST(request: NextRequest) {
  try {
    const payload = normalizeRequest(await request.json().catch(() => null));
    if (!payload) {
      return NextResponse.json({ error: "Absolute file paths are required." }, { status: 400 });
    }

    const rootsByPath = new Map<string, ResolveExternalFileLinkRootsResponse["roots"][number]>();
    for (const filePath of payload.paths) {
      const root = await resolveExternalFileLinkRoot(filePath);
      if (!root) {
        continue;
      }

      rootsByPath.set(root.rootPath.toLowerCase(), {
        id: root.id,
        openPathMode: "absolute",
        rootPath: root.rootPath,
      });
    }

    return NextResponse.json({
      roots: Array.from(rootsByPath.values()),
    } satisfies ResolveExternalFileLinkRootsResponse, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to resolve file link roots.",
    }, { status: 400 });
  }
}
