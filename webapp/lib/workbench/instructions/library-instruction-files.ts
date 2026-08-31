/*
 * Exports:
 * - LibraryInstructionFile/LibraryInstructionFileGeneration: active Workbench Library instruction file and per-use resolver contracts. Keywords: instructions, library, imports, overrides, generation.
 * - createLibraryInstructionFileGeneration: resolve active Markdown files, recursive relative imports, globs, and opaque runtime slots without permanent caching. Keywords: instructions, imports, glob, cycle, runtime.
 */

import fs from "node:fs";
import path from "node:path";

import {
  normalizeWorkbenchLibraryPath,
  workbenchLibraryRoot,
} from "../../workbench-library-paths";

export interface LibraryInstructionFile {
  readonly absolutePath: string;
  readonly content: string;
  readonly key: string;
  readonly relativePath: string;
}

export interface LibraryInstructionFileGeneration {
  list(relativeDirectory: string): LibraryInstructionFile[];
  read(relativePath: string): LibraryInstructionFile;
  render(relativePath: string, slots?: Readonly<Record<string, string | null | undefined>>): string;
}

interface LibraryInstructionFileGenerationOptions {
  readonly rootPath?: string;
}

const MARKDOWN_SUFFIX = ".md";
const OVERRIDE_SUFFIX = ".override.md";
const TEMPLATE_SUFFIX = ".template.md";
const RELATIVE_IMPORT = /\{(\.\/[^{}\r\n]+)\}/gu;
const RUNTIME_SLOT = /\{([a-z][a-z0-9 .-]*)\}/giu;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(value: string) {
  return normalizeWorkbenchLibraryPath(value).replace(/^\/+/u, "");
}

function normalizeRuntimeSlot(value: string) {
  return value.trim().toLowerCase().replace(/\s+/gu, ".");
}

function getActiveFileKey(fileName: string) {
  if (!fileName.endsWith(MARKDOWN_SUFFIX)) return null;
  const withoutSuffix = fileName.endsWith(OVERRIDE_SUFFIX)
    ? fileName.slice(0, -OVERRIDE_SUFFIX.length)
    : fileName.slice(0, -MARKDOWN_SUFFIX.length);
  if (!withoutSuffix || `${withoutSuffix}${MARKDOWN_SUFFIX}`.endsWith(TEMPLATE_SUFFIX)) return null;
  return withoutSuffix.toLowerCase();
}

function getOverridePath(relativePath: string) {
  return relativePath.endsWith(OVERRIDE_SUFFIX)
    ? relativePath
    : `${relativePath.slice(0, -MARKDOWN_SUFFIX.length)}${OVERRIDE_SUFFIX}`;
}

function withMarkdownExtension(relativePath: string) {
  const extension = path.posix.extname(relativePath);
  if (!extension) return `${relativePath}${MARKDOWN_SUFFIX}`;
  if (extension !== MARKDOWN_SUFFIX) {
    throw new Error(`Workbench instruction imports must target Markdown files: ${relativePath}`);
  }
  return relativePath;
}

function formatImportFailure(message: string, chain: readonly string[]) {
  return new Error(`${message}\nImport chain: ${chain.join(" -> ")}`);
}

export function createLibraryInstructionFileGeneration(
  options: LibraryInstructionFileGenerationOptions = {},
): LibraryInstructionFileGeneration {
  const rootPath = path.resolve(options.rootPath ?? workbenchLibraryRoot);
  const realRootPath = fs.realpathSync.native(rootPath);
  const activePaths = new Map<string, string>();
  const expandedContent = new Map<string, string>();
  const files = new Map<string, LibraryInstructionFile>();

  const resolveInsideRoot = (relativePath: string) => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(rootPath, normalizedPath);
    if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Workbench instruction path escapes the Workbench Library: ${relativePath}`);
    }
    return { absolutePath, relativePath: normalizedPath };
  };

  const assertRealPathInsideRoot = (absolutePath: string) => {
    const realPath = fs.realpathSync.native(absolutePath);
    const relativeRealPath = path.relative(realRootPath, realPath);
    if (
      relativeRealPath === ".."
      || relativeRealPath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeRealPath)
    ) {
      throw new Error(`Workbench instruction path escapes the Workbench Library: ${absolutePath}`);
    }
  };

  const fileExists = (relativePath: string) => {
    try {
      const absolutePath = resolveInsideRoot(relativePath).absolutePath;
      const isFile = fs.statSync(absolutePath).isFile();
      if (isFile) assertRealPathInsideRoot(absolutePath);
      return isFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };

  const resolveActivePath = (requestedPath: string) => {
    const normalizedRequest = withMarkdownExtension(normalizeRelativePath(requestedPath));
    const cached = activePaths.get(normalizedRequest);
    if (cached) return cached;
    resolveInsideRoot(normalizedRequest);
    const overridePath = getOverridePath(normalizedRequest);
    const activePath = fileExists(overridePath)
      ? overridePath
      : fileExists(normalizedRequest)
        ? normalizedRequest
        : null;
    if (!activePath) throw new Error(`Workbench instruction file does not exist: ${normalizedRequest}`);
    activePaths.set(normalizedRequest, activePath);
    return activePath;
  };

  const readExactFile = (relativePath: string) => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const cached = files.get(normalizedPath);
    if (cached) return cached;
    const { absolutePath } = resolveInsideRoot(normalizedPath);
    assertRealPathInsideRoot(absolutePath);
    const content = fs.readFileSync(absolutePath, "utf8").replace(/\r\n?/gu, "\n").trim();
    const file: LibraryInstructionFile = {
      absolutePath,
      content,
      key: getActiveFileKey(path.posix.basename(normalizedPath)) ?? path.posix.basename(normalizedPath, MARKDOWN_SUFFIX).toLowerCase(),
      relativePath: normalizedPath,
    };
    files.set(normalizedPath, file);
    return file;
  };

  const read = (relativePath: string) => readExactFile(resolveActivePath(relativePath));

  const list = (relativeDirectory: string) => {
    const normalizedDirectory = normalizeRelativePath(relativeDirectory).replace(/\/+$/u, "");
    const { absolutePath } = resolveInsideRoot(normalizedDirectory);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const activeEntries = new Map<string, { fileName: string; override: boolean }>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const key = getActiveFileKey(entry.name);
      if (!key) continue;
      const override = entry.name.endsWith(OVERRIDE_SUFFIX);
      const existing = activeEntries.get(key);
      if (!existing || override || (!existing.override && compareText(entry.name, existing.fileName) < 0)) {
        activeEntries.set(key, { fileName: entry.name, override });
      }
    }

    return Array.from(activeEntries.entries())
      .sort(([left], [right]) => compareText(left, right))
      .map(([, entry]) => readExactFile(path.posix.join(normalizedDirectory, entry.fileName)));
  };

  const resolveImportPath = (sourcePath: string, importPath: string, chain: readonly string[]) => {
    const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), importPath));
    if (resolvedPath === ".." || resolvedPath.startsWith("../") || path.posix.isAbsolute(resolvedPath)) {
      throw formatImportFailure(
        `Workbench instruction import escapes the Workbench Library: ${importPath}`,
        [...chain, importPath],
      );
    }
    return resolvedPath;
  };

  const expandFile = (file: LibraryInstructionFile, chain: readonly string[]): string => {
    if (chain.includes(file.relativePath)) {
      throw formatImportFailure("Workbench instruction import cycle detected.", [...chain, file.relativePath]);
    }
    const cached = expandedContent.get(file.relativePath);
    if (cached !== undefined) return cached;
    const nextChain = [...chain, file.relativePath];
    let output = "";
    let cursor = 0;
    for (const match of file.content.matchAll(RELATIVE_IMPORT)) {
      const matchIndex = match.index;
      const importPath = match[1];
      if (matchIndex === undefined || !importPath) continue;
      output += file.content.slice(cursor, matchIndex);
      const resolvedPath = resolveImportPath(file.relativePath, importPath, nextChain);
      try {
        if (resolvedPath.endsWith("/*")) {
          const importedFiles = list(resolvedPath.slice(0, -2));
          if (!importedFiles.length) {
            throw new Error(`Workbench instruction glob is empty: ${importPath}`);
          }
          output += importedFiles.map((importedFile) => expandFile(importedFile, nextChain)).join("\n\n");
        } else {
          output += expandFile(read(resolvedPath), nextChain);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("\nImport chain:")) throw error;
        throw formatImportFailure(
          error instanceof Error ? error.message : String(error),
          [...nextChain, resolvedPath],
        );
      }
      cursor = matchIndex + match[0].length;
    }
    output += file.content.slice(cursor);
    expandedContent.set(file.relativePath, output);
    return output;
  };

  const render = (
    relativePath: string,
    slots: Readonly<Record<string, string | null | undefined>> = {},
  ) => {
    const normalizedSlots = new Map(
      Object.entries(slots).map(([key, value]) => [normalizeRuntimeSlot(key), value] as const),
    );
    return expandFile(read(relativePath), []).replace(RUNTIME_SLOT, (match, slot: string) => {
      const value = normalizedSlots.get(normalizeRuntimeSlot(slot));
      return value === null || value === undefined ? match : value;
    });
  };

  return { list, read, render };
}
