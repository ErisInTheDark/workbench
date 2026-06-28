/*
 * Exports:
 * - runtime/dynamic: force scratchpad image assets onto Node.js without static caching. Keywords: collaboration, scratchpad, image assets.
 * - GET/POST: serve, upload, and resolve sibling scratchpad image assets. Keywords: collaboration, scratchpad, image, upload, resolve.
 */

import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import {
  cleanupStaleScratchpadImageAssets,
  ensureScratchpadFile,
  getCollaborationScratchpadRequestPath,
  resolveCollaborationScratchpadFile,
  resolveScratchpadImageAsset,
  uploadScratchpadImageAsset,
} from "../scratchpad-file-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRequiredSearchParam(request: NextRequest, key: string) {
  const value = request.nextUrl.searchParams.get(key)?.trim() ?? "";
  if (!value) {
    throw new Error(`A ${key} parameter is required.`);
  }

  return value;
}

function createAssetUrl(request: NextRequest, projectId: string, scratchpadPath: string, href: string) {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", scratchpadPath);
  url.searchParams.set("href", href);
  return `${url.pathname}${url.search}`;
}

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const scratchpadPath = getCollaborationScratchpadRequestPath(request.nextUrl.searchParams.get("path"), projectId ?? "");
    const href = getRequiredSearchParam(request, "href");
    const scratchpadFile = await resolveCollaborationScratchpadFile(projectId, scratchpadPath);
    const asset = resolveScratchpadImageAsset(scratchpadFile, href);
    const bytes = await fs.readFile(asset.absolutePath);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": asset.contentType,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read scratchpad image asset." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    const scratchpadPath = getCollaborationScratchpadRequestPath(
      typeof body.path === "string" ? body.path : null,
      projectId ?? "",
    );
    const scratchpadFile = await resolveCollaborationScratchpadFile(projectId, scratchpadPath);
    await ensureScratchpadFile(scratchpadFile.absolutePath);

    if (body.action === "resolve") {
      const hrefs = Array.isArray(body.hrefs)
        ? body.hrefs.filter((href): href is string => typeof href === "string")
        : [];
      const assets = (await Promise.all(hrefs.map(async (href) => {
        const asset = resolveScratchpadImageAsset(scratchpadFile, href);
        const stats = await fs.stat(asset.absolutePath).catch(() => null);
        if (!stats?.isFile()) {
          return null;
        }

        return {
          absolutePath: asset.absolutePath,
          assetUrl: createAssetUrl(request, scratchpadFile.projectId, scratchpadFile.displayPath, asset.href),
          contentType: asset.contentType,
          href: asset.href,
        };
      }))).filter((asset): asset is NonNullable<typeof asset> => asset !== null);

      return NextResponse.json({ assets }, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    if (body.action !== "upload" || typeof body.dataUrl !== "string") {
      return NextResponse.json({ error: "Scratchpad image upload data is required." }, { status: 400 });
    }

    const asset = await uploadScratchpadImageAsset(scratchpadFile, body.dataUrl);
    const content = await fs.readFile(scratchpadFile.absolutePath, "utf8").catch(() => "");
    await cleanupStaleScratchpadImageAssets(scratchpadFile, content);

    return NextResponse.json({
      absolutePath: asset.absolutePath,
      assetUrl: createAssetUrl(request, scratchpadFile.projectId, scratchpadFile.displayPath, asset.href),
      contentType: asset.contentType,
      fileName: asset.fileName,
      href: asset.href,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to write scratchpad image asset." }, { status: 400 });
  }
}
