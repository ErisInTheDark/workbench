/*
 * Exports:
 * - SCRATCHPAD_IMAGE_ASSET_RETENTION_MS: grace window before unreferenced scratchpad image assets can be deleted. Keywords: collaboration, scratchpad, image, cleanup.
 * - ResolvedScratchpadFile/ResolvedScratchpadImageAsset/UploadedScratchpadImageAsset: resolved scratchpad and image asset server contracts. Keywords: collaboration, scratchpad, asset.
 * - getCollaborationScratchpadRequestPath/resolveCollaborationScratchpadFile: resolve project or Workbench-owned scratchpad paths. Keywords: collaboration, scratchpad, path.
 * - ensureScratchpadFile/uploadScratchpadImageAsset/resolveScratchpadImageAsset: create scratchpads and manage sibling image assets. Keywords: collaboration, scratchpad, upload, image.
 * - touchReferencedScratchpadImageAssets/cleanupStaleScratchpadImageAssets: maintain last-reference mtimes and delete old detached image assets. Keywords: collaboration, scratchpad, image, cleanup.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createDefaultCollaborationScratchpadContent,
  extractCollaborationScratchpadImages,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad";
import {
  createWorkbenchCollaborationScratchpadRelativePath,
  isWorkbenchOwnedCollaborationScratchpadPath,
} from "../../../../lib/workbench/collaboration/collaboration-scratchpad-path";
import {
  normalizeRelativePath,
  projectRoot,
  resolveProjectFilePath,
  resolveProjectRoot,
  safeResolveProjectPath,
  type ResolvedProject,
} from "../../../../lib/project";

export const SCRATCHPAD_IMAGE_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000;

const DATA_IMAGE_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/iu;
const SCRATCHPAD_IMAGE_ASSET_FILE_PATTERN = /^scratchpad-image-[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u;

export interface ResolvedScratchpadFile {
  absolutePath: string;
  displayPath: string;
  projectId: string;
  rootRelativePath: string;
}

export interface ResolvedScratchpadImageAsset {
  absolutePath: string;
  contentType: string;
  href: string;
}

export interface UploadedScratchpadImageAsset extends ResolvedScratchpadImageAsset {
  fileName: string;
}

function extensionForImageMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

export function contentTypeForScratchpadImageAsset(fileName: string) {
  if (fileName.endsWith(".jpg")) {
    return "image/jpeg";
  }
  if (fileName.endsWith(".webp")) {
    return "image/webp";
  }
  if (fileName.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/png";
}

function parseDataImageUrl(dataUrl: string) {
  const match = DATA_IMAGE_URL_PATTERN.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Only pasted png, jpg, webp, or gif images are supported.");
  }

  return {
    bytes: Buffer.from((match[2] ?? "").replace(/\s+/g, ""), "base64"),
    mimeType: match[1] ?? "image/png",
  };
}

function isPathWithinRoot(rootPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export function getCollaborationScratchpadRequestPath(requestPath: string | null | undefined, projectId: string) {
  return requestPath || createWorkbenchCollaborationScratchpadRelativePath(projectId);
}

function resolveWorkbenchOwnedScratchpadFile(projectId: string, requestPath: string): ResolvedScratchpadFile {
  const normalizedPath = requestPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolutePath = path.resolve(projectRoot, normalizedPath);
  if (!isPathWithinRoot(projectRoot, absolutePath)) {
    throw new Error("Scratchpad path is outside Workbench storage.");
  }

  return {
    absolutePath,
    displayPath: normalizedPath,
    projectId,
    rootRelativePath: normalizedPath,
  };
}

function resolveScratchpadFileInProject(resolvedProject: ResolvedProject, requestPath: string): ResolvedScratchpadFile {
  const resolvedFile = resolveProjectFilePath(resolvedProject, requestPath);
  return {
    absolutePath: resolvedFile.absolutePath,
    displayPath: resolvedFile.displayPath,
    projectId: resolvedProject.id,
    rootRelativePath: resolvedFile.rootRelativePath,
  };
}

export async function resolveCollaborationScratchpadFile(projectId: string | null | undefined, requestPath: string) {
  const resolvedProject = await resolveProjectRoot(projectId);
  if (isWorkbenchOwnedCollaborationScratchpadPath(requestPath)) {
    return resolveWorkbenchOwnedScratchpadFile(resolvedProject.id, requestPath);
  }

  try {
    return resolveScratchpadFileInProject(resolvedProject, requestPath);
  } catch (error) {
    if (
      resolvedProject.kind === "workspace"
      && !requestPath.includes(":")
      && resolvedProject.roots[0]
    ) {
      return resolveScratchpadFileInProject(resolvedProject, `${resolvedProject.roots[0].id}:${requestPath}`);
    }

    throw error;
  }
}

export async function ensureScratchpadFile(absolutePath: string) {
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

function normalizeScratchpadImageHref(href: string) {
  const normalizedHref = normalizeRelativePath(href).replace(/^\.\/+/, "").trim();
  if (
    !normalizedHref
    || normalizedHref.includes("/")
    || normalizedHref.includes(":")
    || normalizedHref === "."
    || normalizedHref === ".."
    || !SCRATCHPAD_IMAGE_ASSET_FILE_PATTERN.test(normalizedHref)
  ) {
    throw new Error("Scratchpad image links must reference a Workbench-created sibling image file.");
  }

  return normalizedHref;
}

export function resolveScratchpadImageAsset(scratchpadFile: ResolvedScratchpadFile, href: string): ResolvedScratchpadImageAsset {
  const normalizedHref = normalizeScratchpadImageHref(href);
  const scratchpadDirectory = path.dirname(scratchpadFile.absolutePath);
  const absolutePath = safeResolveProjectPath(scratchpadDirectory, normalizedHref);
  if (!isPathWithinRoot(scratchpadDirectory, absolutePath)) {
    throw new Error("Scratchpad image path is outside the scratchpad folder.");
  }

  return {
    absolutePath,
    contentType: contentTypeForScratchpadImageAsset(normalizedHref),
    href: normalizedHref,
  };
}

export async function uploadScratchpadImageAsset(scratchpadFile: ResolvedScratchpadFile, dataUrl: string): Promise<UploadedScratchpadImageAsset> {
  const parsedImage = parseDataImageUrl(dataUrl);
  const hash = crypto.createHash("sha256").update(parsedImage.bytes).digest("hex");
  const extension = extensionForImageMimeType(parsedImage.mimeType);
  const fileName = `scratchpad-image-${hash}.${extension}`;
  const asset = resolveScratchpadImageAsset(scratchpadFile, fileName);

  await fs.mkdir(path.dirname(asset.absolutePath), { recursive: true });
  try {
    await fs.writeFile(asset.absolutePath, parsedImage.bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const now = new Date();
  await fs.utimes(asset.absolutePath, now, now).catch(() => undefined);

  return {
    ...asset,
    fileName,
  };
}

export async function touchReferencedScratchpadImageAssets(scratchpadFile: ResolvedScratchpadFile, content: string) {
  const now = new Date();
  await Promise.all(extractCollaborationScratchpadImages(content).map(async (image) => {
    const asset = resolveScratchpadImageAsset(scratchpadFile, image.href);
    await fs.utimes(asset.absolutePath, now, now).catch(() => undefined);
  }));
}

export async function cleanupStaleScratchpadImageAssets(
  scratchpadFile: ResolvedScratchpadFile,
  content: string,
  nowMs = Date.now(),
) {
  const scratchpadDirectory = path.dirname(scratchpadFile.absolutePath);
  const referencedHrefs = new Set(extractCollaborationScratchpadImages(content).map((image) => image.href));
  let entries: string[];
  try {
    entries = await fs.readdir(scratchpadDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!SCRATCHPAD_IMAGE_ASSET_FILE_PATTERN.test(entry) || referencedHrefs.has(entry)) {
      return;
    }

    const asset = resolveScratchpadImageAsset(scratchpadFile, entry);
    const stats = await fs.stat(asset.absolutePath).catch(() => null);
    if (!stats?.isFile() || nowMs - stats.mtimeMs < SCRATCHPAD_IMAGE_ASSET_RETENTION_MS) {
      return;
    }

    await fs.unlink(asset.absolutePath).catch(() => undefined);
  }));
}
