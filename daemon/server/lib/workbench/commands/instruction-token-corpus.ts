/*
 * Exports:
 * - InstructionTokenSection/InstructionTokenSource: source-owned preamble and heading ranges for token diagnostics.
 * - WorkbenchInstructionTokenCorpus/buildWorkbenchInstructionTokenCorpus: build stripped Workbench source text and section provenance.
 * - ProjectInstructionTokenCorpus/buildProjectInstructionTokenCorpus: build one resolved AGENTS graph and active-source sections.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { stripWorkbenchInstructionHtmlComments } from "../instructions/instruction-context-filter";
import {
  buildProjectInstructionContentWithSources,
  type ProjectInstructionContext,
} from "../instructions/project-instruction-files";
import { listMarkdownHeadingRanges } from "../markdown/markdown-heading-ranges";

export interface InstructionTokenSection {
  readonly content: string;
  readonly endLine: number;
  readonly heading: string | null;
  readonly startLine: number;
}

export interface InstructionTokenSource {
  readonly content: string;
  readonly path: string;
  readonly sections: readonly InstructionTokenSection[];
}

export interface WorkbenchInstructionTokenCorpus {
  readonly content: string;
  readonly files: readonly string[];
  readonly sources: readonly InstructionTokenSource[];
}

export interface ProjectInstructionTokenCorpus {
  readonly content: string;
  readonly files: readonly string[];
  readonly sources: readonly InstructionTokenSource[];
}

async function listMarkdownLeaves(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? await listMarkdownLeaves(root, entryPath)
      : entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".template.md")
        ? [entryPath]
        : [];
  }));
  return files.flat();
}

function preserveLineBreaks(value: string) {
  return value.replace(/[^\r\n]/gu, "");
}

function stripInstructionSourceSyntax(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, preserveLineBreaks)
    .replace(/<\/?[A-Za-z][^>]*>/gu, "")
    .replace(/\{\.\/[^{}\r\n]+\}/gu, "")
    .replace(/\{\{?[a-z][a-z0-9 .-]*\}\}?/gu, "")
    .trim();
}

function stripProjectInstructionSourceSyntax(content: string) {
  return stripWorkbenchInstructionHtmlComments(content)
    .replace(/\{\.\/[^{}\r\n]+\}/gu, "")
    .trim();
}

function lineCount(value: string) {
  if (!value) return 0;
  return value.split("\n").length;
}

function createInstructionTokenSource(
  sourcePath: string,
  sourceContent: string,
  stripSourceSyntax: (content: string) => string,
): InstructionTokenSource {
  const normalizedSource = sourceContent.replace(/\r\n?/gu, "\n");
  const headings = listMarkdownHeadingRanges(normalizedSource);
  const sections: InstructionTokenSection[] = [];
  const firstHeading = headings[0];
  if (firstHeading) {
    const content = stripSourceSyntax(normalizedSource.slice(0, firstHeading.startOffset));
    if (content) {
      sections.push({
        content,
        endLine: firstHeading.startLine - 1,
        heading: null,
        startLine: 1,
      });
    }
  } else {
    const content = stripSourceSyntax(normalizedSource);
    if (content) {
      sections.push({
        content,
        endLine: lineCount(normalizedSource),
        heading: null,
        startLine: 1,
      });
    }
  }
  sections.push(...headings.map((heading) => ({
    content: stripSourceSyntax(normalizedSource.slice(heading.startOffset, heading.endOffset)),
    endLine: heading.endLine,
    heading: heading.source,
    startLine: heading.startLine,
  })));
  return {
    content: stripSourceSyntax(normalizedSource),
    path: sourcePath,
    sections,
  };
}

export async function buildWorkbenchInstructionTokenCorpus(root: string): Promise<WorkbenchInstructionTokenCorpus> {
  const absoluteRoot = path.resolve(root);
  const absoluteFiles = (await listMarkdownLeaves(absoluteRoot)).sort((left, right) => left.localeCompare(right));
  const sources = await Promise.all(absoluteFiles.map(async (filePath) => createInstructionTokenSource(
    path.relative(absoluteRoot, filePath).replaceAll("\\", "/"),
    await readFile(filePath, "utf8"),
    stripInstructionSourceSyntax,
  )));
  return {
    content: sources.map(({ content }) => content).filter(Boolean).join("\n\n"),
    files: sources.map(({ path: sourcePath }) => sourcePath),
    sources,
  };
}

export function buildProjectInstructionTokenCorpus(
  context: ProjectInstructionContext,
): ProjectInstructionTokenCorpus {
  const resolved = buildProjectInstructionContentWithSources(context);
  if (!resolved) return { content: "", files: [], sources: [] };
  const activeSources = new Map<string, string>();
  for (const source of resolved.sources) {
    const relativePath = path.relative(resolved.rootPath, source.absolutePath).replaceAll("\\", "/");
    activeSources.set(relativePath, source.sourceContent);
  }
  const sources = [...activeSources.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourcePath, sourceContent]) => createInstructionTokenSource(
      sourcePath,
      sourceContent,
      stripProjectInstructionSourceSyntax,
    ));
  return {
    content: stripWorkbenchInstructionHtmlComments(resolved.content).trim(),
    files: sources.map(({ path: sourcePath }) => sourcePath),
    sources,
  };
}
