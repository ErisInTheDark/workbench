/*
 * Exports:
 * - WorkbenchInstructionSourceFile: one internal Markdown source mirrored to the Workbench Library. Keywords: instructions, source, path.
 * - readWorkbenchInstructionSources: discover and read the complete internal Markdown mirror once. Keywords: instructions, markdown, discovery.
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
let sourceRefresh: Promise<void> | null = null;

export interface WorkbenchInstructionSourceFile {
  readonly content: string;
  readonly relativePath: string;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getInstructionSourceRoot() {
  return path.join(process.cwd(), "lib", "workbench", "instructions");
}

function normalizeContent(value: string) {
  return `${value.replace(/\r\n?/gu, "\n").trim()}\n`;
}

function listMarkdownPaths(rootPath: string, relativeDirectory = ""): string[] {
  const directoryPath = path.join(rootPath, relativeDirectory);
  return readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) return listMarkdownPaths(rootPath, relativePath);
      if (!entry.isFile() || !entry.name.endsWith(MARKDOWN_SUFFIX)) return [];
      if (entry.name.endsWith(OVERRIDE_SUFFIX)) {
        throw new Error(`Internal Workbench instruction sources cannot define user overrides: ${relativePath}`);
      }
      return [relativePath];
    });
}

export function readWorkbenchInstructionSources(): WorkbenchInstructionSourceFile[] {
  const rootPath = getInstructionSourceRoot();
  return listMarkdownPaths(rootPath).map((relativePath) => {
    const sourcePath = path.join(rootPath, relativePath);
    const content = readFileSync(sourcePath, "utf8").replace(/\r\n?/gu, "\n").trim();
    observeReloadInstructionSource(sourcePath);
    return { content, relativePath };
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
