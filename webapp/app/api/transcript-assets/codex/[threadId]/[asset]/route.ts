/*
 * Exports:
 * - GET: serve hashed Codex transcript image assets from the local transcript store. Keywords: transcript, codex, image assets.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { projectRoot } from "../../../../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THREAD_DIRECTORY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ASSET_FILE_PATTERN = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u;

function isPathWithinRoot(rootPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function contentTypeForAsset(asset: string) {
  if (asset.endsWith(".jpg")) {
    return "image/jpeg";
  }
  if (asset.endsWith(".webp")) {
    return "image/webp";
  }
  if (asset.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/png";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string; asset: string }> },
) {
  const { threadId, asset } = await params;
  if (!THREAD_DIRECTORY_PATTERN.test(threadId) || !ASSET_FILE_PATTERN.test(asset)) {
    return NextResponse.json({ error: "Invalid transcript asset path." }, { status: 400 });
  }

  const rootPath = path.join(projectRoot, ".workbench", "transcripts", "codex", "threads", threadId, "assets");
  const assetPath = path.join(rootPath, asset);
  if (!isPathWithinRoot(rootPath, assetPath)) {
    return NextResponse.json({ error: "Invalid transcript asset path." }, { status: 400 });
  }

  try {
    const bytes = await fs.readFile(assetPath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": contentTypeForAsset(asset),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "Transcript asset not found." }, { status: 404 });
    }
    throw error;
  }
}
