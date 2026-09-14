/*
 * Exports:
 * - InstructionFile/InstructionFileGeneration: active instruction file and per-generation resolver contracts. Keywords: instructions, files, generation.
 * - InstructionSourceSpan/RenderedInstructionContent: rendered text provenance back to active source files.
 * - createInstructionFileGeneration: resolve root-bounded Markdown files, recursive imports, globs, overrides, and opaque runtime slots. Keywords: imports, glob, cycle, runtime, root.
 */

import fs from "node:fs";
import path from "node:path";

export interface InstructionFile {
  readonly absolutePath: string;
  readonly content: string;
  readonly key: string;
  readonly relativePath: string;
}

export interface InstructionFileGeneration {
  list(relativeDirectory: string): InstructionFile[];
  read(relativePath: string): InstructionFile;
  render(relativePath: string, slots?: Readonly<Record<string, string | null | undefined>>): string;
  renderWithSources(relativePath: string, slots?: Readonly<Record<string, string | null | undefined>>): RenderedInstructionContent;
}

export interface InstructionSourceSpan {
  readonly absolutePath: string;
  readonly outputEnd: number;
  readonly outputStart: number;
  readonly sourceContent: string;
  readonly sourceStart: number;
}

export interface RenderedInstructionContent {
  readonly content: string;
  readonly sources: readonly InstructionSourceSpan[];
}

interface InstructionFileGenerationOptions {
  readonly rootPath: string;
  readonly scopeLabel: string;
}

const MARKDOWN_SUFFIX = ".md";
const OVERRIDE_SUFFIX = ".override.md";
const TEMPLATE_SUFFIX = ".template.md";
const RELATIVE_IMPORT = /\{(\.\/[^{}\r\n]+)\}/gu;
const RUNTIME_SLOT = /\{([a-z][a-z0-9 .-]*)\}/giu;

function sliceRenderedContent(rendered: RenderedInstructionContent, start: number, end: number): RenderedInstructionContent {
  return {
    content: rendered.content.slice(start, end),
    sources: rendered.sources.flatMap((source) => {
      const overlapStart = Math.max(source.outputStart, start);
      const overlapEnd = Math.min(source.outputEnd, end);
      if (overlapStart >= overlapEnd) return [];
      return [{
        ...source,
        outputEnd: overlapEnd - start,
        outputStart: overlapStart - start,
        sourceStart: source.sourceStart + overlapStart - source.outputStart,
      }];
    }),
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(value: string) {
  const normalizedPath = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\/+/u, ""));
  return normalizedPath === "." ? "" : normalizedPath;
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

function withMarkdownExtension(relativePath: string, scopeLabel: string) {
  const extension = path.posix.extname(relativePath);
  if (!extension) return `${relativePath}${MARKDOWN_SUFFIX}`;
  if (extension !== MARKDOWN_SUFFIX) {
    throw new Error(`Instruction imports in ${scopeLabel} must target Markdown files: ${relativePath}`);
  }
  return relativePath;
}

function formatImportFailure(message: string, chain: readonly string[]) {
  return new Error(`${message}\nImport chain: ${chain.join(" -> ")}`);
}

export function createInstructionFileGeneration(
  options: InstructionFileGenerationOptions,
): InstructionFileGeneration {
  const rootPath = path.resolve(options.rootPath);
  const realRootPath = fs.realpathSync.native(rootPath);
  const activePaths = new Map<string, string>();
  const expandedContent = new Map<string, RenderedInstructionContent>();
  const files = new Map<string, InstructionFile>();
  const sourceMetadata = new Map<string, { contentStart: number; sourceContent: string }>();

  const resolveInsideRoot = (relativePath: string) => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(rootPath, normalizedPath);
    if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Instruction path escapes ${options.scopeLabel}: ${relativePath}`);
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
      throw new Error(`Instruction path escapes ${options.scopeLabel}: ${absolutePath}`);
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
    const normalizedRequest = withMarkdownExtension(normalizeRelativePath(requestedPath), options.scopeLabel);
    const cached = activePaths.get(normalizedRequest);
    if (cached) return cached;
    resolveInsideRoot(normalizedRequest);
    const overridePath = getOverridePath(normalizedRequest);
    const activePath = fileExists(overridePath)
      ? overridePath
      : fileExists(normalizedRequest)
        ? normalizedRequest
        : null;
    if (!activePath) {
      throw new Error(`Instruction file does not exist in ${options.scopeLabel}: ${normalizedRequest}`);
    }
    activePaths.set(normalizedRequest, activePath);
    return activePath;
  };

  const readExactFile = (relativePath: string) => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const cached = files.get(normalizedPath);
    if (cached) return cached;
    const { absolutePath } = resolveInsideRoot(normalizedPath);
    assertRealPathInsideRoot(absolutePath);
    const sourceContent = fs.readFileSync(absolutePath, "utf8").replace(/\r\n?/gu, "\n");
    const content = sourceContent.trim();
    const file: InstructionFile = {
      absolutePath,
      content,
      key: getActiveFileKey(path.posix.basename(normalizedPath))
        ?? path.posix.basename(normalizedPath, MARKDOWN_SUFFIX).toLowerCase(),
      relativePath: normalizedPath,
    };
    files.set(normalizedPath, file);
    sourceMetadata.set(normalizedPath, {
      contentStart: content ? sourceContent.indexOf(content) : 0,
      sourceContent,
    });
    return file;
  };

  const read = (relativePath: string) => readExactFile(resolveActivePath(relativePath));

  const list = (relativeDirectory: string) => {
    const normalizedDirectory = normalizeRelativePath(relativeDirectory).replace(/\/+$/u, "");
    const { absolutePath } = resolveInsideRoot(normalizedDirectory);
    let entries: fs.Dirent[];
    try {
      assertRealPathInsideRoot(absolutePath);
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
        `Instruction import escapes ${options.scopeLabel}: ${importPath}`,
        [...chain, importPath],
      );
    }
    return resolvedPath;
  };

  const expandFile = (file: InstructionFile, chain: readonly string[]): RenderedInstructionContent => {
    if (chain.includes(file.relativePath)) {
      throw formatImportFailure(
        `Instruction import cycle detected in ${options.scopeLabel}.`,
        [...chain, file.relativePath],
      );
    }
    const cached = expandedContent.get(file.relativePath);
    if (cached !== undefined) return cached;
    const nextChain = [...chain, file.relativePath];
    const metadata = sourceMetadata.get(file.relativePath);
    if (!metadata) throw new Error(`Instruction source metadata is unavailable: ${file.relativePath}`);
    let output = "";
    const sources: InstructionSourceSpan[] = [];
    let cursor = 0;
    const appendSource = (start: number, end: number) => {
      if (start >= end) return;
      const outputStart = output.length;
      output += file.content.slice(start, end);
      sources.push({
        absolutePath: file.absolutePath,
        outputEnd: output.length,
        outputStart,
        sourceContent: metadata.sourceContent,
        sourceStart: metadata.contentStart + start,
      });
    };
    const appendRendered = (rendered: RenderedInstructionContent) => {
      const outputStart = output.length;
      output += rendered.content;
      sources.push(...rendered.sources.map((source) => ({
        ...source,
        outputEnd: outputStart + source.outputEnd,
        outputStart: outputStart + source.outputStart,
      })));
    };
    for (const match of file.content.matchAll(RELATIVE_IMPORT)) {
      const matchIndex = match.index;
      const importPath = match[1];
      if (matchIndex === undefined || !importPath) continue;
      appendSource(cursor, matchIndex);
      const resolvedPath = resolveImportPath(file.relativePath, importPath, nextChain);
      try {
        if (resolvedPath.endsWith("/*")) {
          const importedFiles = list(resolvedPath.slice(0, -2));
          if (!importedFiles.length) {
            throw new Error(`Instruction glob is empty in ${options.scopeLabel}: ${importPath}`);
          }
          importedFiles.forEach((importedFile, index) => {
            if (index > 0) output += "\n\n";
            appendRendered(expandFile(importedFile, nextChain));
          });
        } else {
          appendRendered(expandFile(read(resolvedPath), nextChain));
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
    appendSource(cursor, file.content.length);
    const expanded = { content: output, sources };
    expandedContent.set(file.relativePath, expanded);
    return expanded;
  };

  const renderWithSources = (
    relativePath: string,
    slots: Readonly<Record<string, string | null | undefined>> = {},
  ) => {
    const normalizedSlots = new Map(
      Object.entries(slots).map(([key, value]) => [normalizeRuntimeSlot(key), value] as const),
    );
    const expanded = expandFile(read(relativePath), []);
    let output = "";
    const sources: InstructionSourceSpan[] = [];
    let cursor = 0;
    const appendRendered = (rendered: RenderedInstructionContent) => {
      const outputStart = output.length;
      output += rendered.content;
      sources.push(...rendered.sources.map((source) => ({
        ...source,
        outputEnd: outputStart + source.outputEnd,
        outputStart: outputStart + source.outputStart,
      })));
    };
    for (const match of expanded.content.matchAll(RUNTIME_SLOT)) {
      const matchIndex = match.index;
      const slot = match[1];
      if (matchIndex === undefined || !slot) continue;
      const value = normalizedSlots.get(normalizeRuntimeSlot(slot));
      if (value === null || value === undefined) continue;
      appendRendered(sliceRenderedContent(expanded, cursor, matchIndex));
      output += value;
      cursor = matchIndex + match[0].length;
    }
    appendRendered(sliceRenderedContent(expanded, cursor, expanded.content.length));
    return { content: output, sources };
  };

  const render: InstructionFileGeneration["render"] = (relativePath, slots) => (
    renderWithSources(relativePath, slots).content
  );

  return { list, read, render, renderWithSources };
}
