/*
 * Exports:
 * - WorkbenchInstructionTokenCorpus: deterministic stripped instruction text plus its contributing source paths. Keywords: instructions, tokens, corpus, measurement.
 * - buildWorkbenchInstructionTokenCorpus: read runtime Markdown leaves and remove source-only control syntax before token counting. Keywords: instructions, tokens, comments, selectors, imports.
 * - ProjectInstructionTokenCorpus/buildProjectInstructionTokenCorpus: resolve one cwd-owned AGENTS chain and remove source comments before counting. Keywords: project, AGENTS, tokens, imports, comments.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { stripWorkbenchInstructionHtmlComments } from "../instructions/instruction-context-filter";
import {
  buildProjectInstructionContent,
  type ProjectInstructionContext,
} from "../instructions/project-instruction-files";

export interface WorkbenchInstructionTokenCorpus {
  readonly content: string;
  readonly files: readonly string[];
}

export interface ProjectInstructionTokenCorpus {
  readonly content: string;
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

export async function buildWorkbenchInstructionTokenCorpus(root: string): Promise<WorkbenchInstructionTokenCorpus> {
  const absoluteRoot = path.resolve(root);
  const absoluteFiles = (await listMarkdownLeaves(absoluteRoot)).sort((left, right) => left.localeCompare(right));
  const sources = await Promise.all(absoluteFiles.map(async (filePath) => stripInstructionSourceSyntax(await readFile(filePath, "utf8"))));
  return {
    content: sources.filter(Boolean).join("\n\n"),
    files: absoluteFiles.map((filePath) => path.relative(absoluteRoot, filePath).replaceAll("\\", "/")),
  };
}

export function buildProjectInstructionTokenCorpus(
  context: ProjectInstructionContext,
): ProjectInstructionTokenCorpus {
  const content = buildProjectInstructionContent(context) ?? "";
  return {
    content: stripWorkbenchInstructionHtmlComments(content).trim(),
  };
}
