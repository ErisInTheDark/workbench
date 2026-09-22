/*
 * Exports:
 * - ProjectInstructionContext: cwd and workspace roots used to select one project instruction chain.
 * - ProjectInstructionContent/buildProjectInstructionContentWithSources: resolve instruction content with active-source provenance.
 * - buildProjectInstructionContent: read the current owning root-to-cwd AGENTS chain without source narration.
 */

import fs from "node:fs";
import path from "node:path";

import { isPathWithinRoot } from "../../project";
import {
  createInstructionFileGeneration,
  type InstructionSourceSpan,
  type RenderedInstructionContent,
} from "./instruction-file-generation";

export interface ProjectInstructionContext {
  readonly cwd?: string | null;
  readonly roots?: readonly { readonly rootPath: string }[] | null;
}

export interface ProjectInstructionContent extends RenderedInstructionContent {
  readonly rootPath: string;
}

const AGENTS_FILE_NAME = "AGENTS.md";
const AGENTS_OVERRIDE_FILE_NAME = "AGENTS.override.md";

function isFile(filePath: string) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function selectOwningRoot(context: ProjectInstructionContext) {
  const cwd = context.cwd?.trim();
  if (!cwd) return null;
  const resolvedCwd = path.resolve(cwd);
  const root = (context.roots ?? [])
    .map((candidate) => path.resolve(candidate.rootPath))
    .filter((candidate) => isPathWithinRoot(resolvedCwd, candidate))
    .sort((left, right) => right.length - left.length)[0];
  return root ? { cwd: resolvedCwd, root } : null;
}

function listChainDirectories(rootPath: string, cwd: string) {
  const relativeCwd = path.relative(rootPath, cwd);
  const segments = relativeCwd ? relativeCwd.split(path.sep).filter(Boolean) : [];
  const directories = [rootPath];
  let currentDirectory = rootPath;
  for (const segment of segments) {
    currentDirectory = path.join(currentDirectory, segment);
    directories.push(currentDirectory);
  }
  return directories;
}

function trimRenderedContent(rendered: RenderedInstructionContent): RenderedInstructionContent {
  const content = rendered.content.trim();
  const outputStart = content ? rendered.content.indexOf(content) : 0;
  const outputEnd = outputStart + content.length;
  return {
    content,
    sources: rendered.sources.flatMap((source) => {
      const overlapStart = Math.max(source.outputStart, outputStart);
      const overlapEnd = Math.min(source.outputEnd, outputEnd);
      if (overlapStart >= overlapEnd) return [];
      return [{
        ...source,
        outputEnd: overlapEnd - outputStart,
        outputStart: overlapStart - outputStart,
        sourceStart: source.sourceStart + overlapStart - source.outputStart,
      }];
    }),
  };
}

export function buildProjectInstructionContentWithSources(
  context: ProjectInstructionContext,
): ProjectInstructionContent | null {
  const owner = selectOwningRoot(context);
  if (!owner) return null;

  const instructionFiles = createInstructionFileGeneration({
    rootPath: owner.root,
    scopeLabel: "project instructions",
  });
  const sections = listChainDirectories(owner.root, owner.cwd)
    .filter((directory) => (
      isFile(path.join(directory, AGENTS_OVERRIDE_FILE_NAME))
      || isFile(path.join(directory, AGENTS_FILE_NAME))
    ))
    .map((directory) => {
      const relativePath = path.relative(owner.root, path.join(directory, AGENTS_FILE_NAME))
        .split(path.sep)
        .join("/");
      return trimRenderedContent(instructionFiles.renderWithSources(relativePath));
    })
    .filter(({ content }) => content);
  if (!sections.length) return null;

  let content = "";
  const sources: InstructionSourceSpan[] = [];
  sections.forEach((section, index) => {
    if (index > 0) content += "\n\n";
    const outputStart = content.length;
    content += section.content;
    sources.push(...section.sources.map((source) => ({
      ...source,
      outputEnd: outputStart + source.outputEnd,
      outputStart: outputStart + source.outputStart,
    })));
  });

  return { content, rootPath: owner.root, sources };
}

export function buildProjectInstructionContent(context: ProjectInstructionContext) {
  return buildProjectInstructionContentWithSources(context)?.content ?? null;
}
