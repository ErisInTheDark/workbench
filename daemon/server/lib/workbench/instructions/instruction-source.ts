/*
 * Exports:
 * - WorkbenchInstructionSourceFile: one repository Markdown source mirrored to the Workbench Library. Keywords: instructions, source, path.
 * - WorkbenchInstructionTombstone: one empty repository marker targeting a retired Workbench Library file. Keywords: instructions, tombstone, retirement.
 * - readWorkbenchInstructionSources: discover and read the complete repository Markdown mirror once. Keywords: instructions, markdown, discovery.
 * - readWorkbenchInstructionTombstones: discover and validate retired instruction markers. Keywords: instructions, tombstone, discovery.
 * - ensureWorkbenchInstructionSourceFiles: refresh generated library files while preserving the user-owned default agent and overrides. Keywords: instructions, emission, freshness.
 */

import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { observeReloadInstructionSource } from "../reload-source-observer";
import {
  safeResolveWorkbenchLibraryPath,
  workbenchLibraryRoot,
} from "../../workbench-library-paths";

const DEFAULT_AGENT_PATH = "agents/default.md";
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

function listInstructionPaths(rootPath: string, relativeDirectory = ""): string[] {
  const directoryPath = path.join(rootPath, relativeDirectory);
  return readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) return listInstructionPaths(rootPath, relativePath);
      if (!entry.isFile() || (!entry.name.endsWith(MARKDOWN_SUFFIX) && !entry.name.endsWith(TOMBSTONE_SUFFIX))) return [];
      if (entry.name.endsWith(OVERRIDE_SUFFIX)) {
        throw new Error(`Internal Workbench instruction sources cannot define user overrides: ${relativePath}`);
      }
      return [relativePath];
    });
}

export function readWorkbenchInstructionSources(rootPath = getInstructionSourceRoot()): WorkbenchInstructionSourceFile[] {
  return listInstructionPaths(rootPath)
    .filter((relativePath) => relativePath.endsWith(MARKDOWN_SUFFIX))
    .map((relativePath) => {
      const sourcePath = path.join(rootPath, relativePath);
      const content = readFileSync(sourcePath, "utf8").replace(/\r\n?/gu, "\n").trim();
      observeReloadInstructionSource(sourcePath);
      return { content, relativePath };
    });
}

export function readWorkbenchInstructionTombstones(rootPath = getInstructionSourceRoot()): WorkbenchInstructionTombstone[] {
  return listInstructionPaths(rootPath)
    .filter((relativePath) => relativePath.endsWith(TOMBSTONE_SUFFIX))
    .map((markerRelativePath) => {
      const sourcePath = path.join(rootPath, markerRelativePath);
      if (readFileSync(sourcePath, "utf8").trim()) {
        throw new Error(`Instruction tombstone must be empty: ${markerRelativePath}`);
      }
      observeReloadInstructionSource(sourcePath);
      const targetRelativePath = markerRelativePath.slice(0, -".tombstone".length);
      if (targetRelativePath === DEFAULT_AGENT_PATH || targetRelativePath.endsWith(OVERRIDE_SUFFIX)) {
        throw new Error(`Instruction tombstone cannot target a user-owned file: ${targetRelativePath}`);
      }
      return { markerRelativePath, targetRelativePath };
    });
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

async function writeFileIfMissing(relativePath: string, content: string) {
  const absolutePath = safeResolveWorkbenchLibraryPath(relativePath);
  try {
    await fs.access(absolutePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, normalizeContent(content), "utf8");
}

async function refreshWorkbenchInstructionSourceFiles() {
  await fs.mkdir(workbenchLibraryRoot, { recursive: true });
  const sources = readWorkbenchInstructionSources();
  await Promise.all(sources.map((source) => (
    source.relativePath === DEFAULT_AGENT_PATH
      ? writeFileIfMissing(source.relativePath, source.content)
      : writeGeneratedFile(source.relativePath, source.content)
  )));
}

export async function ensureWorkbenchInstructionSourceFiles() {
  sourceRefresh ??= refreshWorkbenchInstructionSourceFiles();
  try {
    await sourceRefresh;
  } catch (error) {
    sourceRefresh = null;
    throw error;
  }
}
