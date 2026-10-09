/*
 * Exports:
 * - WorkbenchInstructionSourceFile: one repository Markdown source mirrored to the Workbench Library. Keywords: instructions, source, path.
 * - WorkbenchInstructionTombstone: one empty repository marker targeting a retired Workbench Library file. Keywords: instructions, tombstone, retirement.
 * - readWorkbenchInstructionSources: discover and read the complete repository Markdown mirror once. Keywords: instructions, markdown, discovery.
 * - readWorkbenchInstructionTombstones: discover and validate retired instruction markers. Keywords: instructions, tombstone, discovery.
 * - ensureWorkbenchInstructionSourceFiles: refresh generated library files on every call (overlapping calls share one pass) while preserving user overrides. Keywords: instructions, emission, freshness.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { observeReloadInstructionSource } from "../reload-source-observer";
import {
  safeResolveWorkbenchLibraryPath,
  workbenchLibraryRoot,
} from "../../workbench-library-paths";

const MARKDOWN_SUFFIX = ".md";
const OVERRIDE_SUFFIX = ".override.md";
const TOMBSTONE_SUFFIX = ".md.tombstone";
let sourceRefresh: Promise<void> | null = null;

export interface WorkbenchInstructionSourceFile {
  readonly content: string;
  readonly relativePath: string;
}

export interface WorkbenchInstructionTombstone {
  readonly markerRelativePath: string;
  readonly targetRelativePath: string;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getInstructionSourceRoot() {
  return path.resolve(process.cwd(), "..", "instructions");
}

function normalizeContent(value: string) {
  return `${value.replace(/\r\n?/gu, "\n").trim()}\n`;
}

async function listInstructionPaths(rootPath: string, relativeDirectory = ""): Promise<string[]> {
  const directoryPath = path.join(rootPath, relativeDirectory);
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) return await listInstructionPaths(rootPath, relativePath);
    if (!entry.isFile() || (!entry.name.endsWith(MARKDOWN_SUFFIX) && !entry.name.endsWith(TOMBSTONE_SUFFIX))) return [];
    if (entry.name.endsWith(OVERRIDE_SUFFIX)) {
      throw new Error(`Internal Workbench instruction sources cannot define user overrides: ${relativePath}`);
    }
    return [relativePath];
  }));
  return nested.flat();
}

export async function readWorkbenchInstructionSources(rootPath = getInstructionSourceRoot()): Promise<WorkbenchInstructionSourceFile[]> {
  const relativePaths = (await listInstructionPaths(rootPath)).filter((relativePath) => relativePath.endsWith(MARKDOWN_SUFFIX));
  return await Promise.all(relativePaths.map(async (relativePath) => {
    const sourcePath = path.join(rootPath, relativePath);
    const content = (await fs.readFile(sourcePath, "utf8")).replace(/\r\n?/gu, "\n").trim();
    observeReloadInstructionSource(sourcePath);
    return { content, relativePath };
  }));
}

export async function readWorkbenchInstructionTombstones(rootPath = getInstructionSourceRoot()): Promise<WorkbenchInstructionTombstone[]> {
  const markerPaths = (await listInstructionPaths(rootPath)).filter((relativePath) => relativePath.endsWith(TOMBSTONE_SUFFIX));
  return await Promise.all(markerPaths.map(async (markerRelativePath) => {
    const sourcePath = path.join(rootPath, markerRelativePath);
    if ((await fs.readFile(sourcePath, "utf8")).trim()) {
      throw new Error(`Instruction tombstone must be empty: ${markerRelativePath}`);
    }
    observeReloadInstructionSource(sourcePath);
    const targetRelativePath = markerRelativePath.slice(0, -".tombstone".length);
    if (targetRelativePath.endsWith(OVERRIDE_SUFFIX)) {
      throw new Error(`Instruction tombstone cannot target a user-owned file: ${targetRelativePath}`);
    }
    return { markerRelativePath, targetRelativePath };
  }));
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeGeneratedFile(relativePath: string, content: string) {
  const absolutePath = safeResolveWorkbenchLibraryPath(relativePath);
  const normalizedContent = normalizeContent(content);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const currentContent = await readTextFile(absolutePath);
  if (currentContent !== null && normalizeContent(currentContent) === normalizedContent) return;
  await fs.writeFile(absolutePath, normalizedContent, "utf8");
}

async function refreshWorkbenchInstructionSourceFiles() {
  await fs.mkdir(workbenchLibraryRoot, { recursive: true });
  const sources = await readWorkbenchInstructionSources();
  await Promise.all(sources.map((source) => writeGeneratedFile(source.relativePath, source.content)));
}

/** Every call mirrors current sources (edits apply on the next prompt build); only overlapping calls share one pass. */
export async function ensureWorkbenchInstructionSourceFiles() {
  sourceRefresh ??= refreshWorkbenchInstructionSourceFiles().finally(() => { sourceRefresh = null; });
  await sourceRefresh;
}
