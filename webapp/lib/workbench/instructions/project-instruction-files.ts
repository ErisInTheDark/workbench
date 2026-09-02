/*
 * Exports:
 * - ProjectInstructionContext: cwd and workspace roots used to select one project instruction chain. Keywords: project, cwd, roots, AGENTS.
 * - buildProjectInstructionContent: read the current owning root-to-cwd AGENTS chain without source narration. Keywords: project, AGENTS, override, prompt.
 */

import fs from "node:fs";
import path from "node:path";

import { isPathWithinRoot } from "../../project";
import type { WorkbenchProjectRoot } from "../../types";
import { createInstructionFileGeneration } from "./instruction-file-generation";

export interface ProjectInstructionContext {
  readonly cwd?: string | null;
  readonly roots?: readonly WorkbenchProjectRoot[] | null;
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

export function buildProjectInstructionContent(context: ProjectInstructionContext) {
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
      return instructionFiles.render(relativePath).trim();
    })
    .filter(Boolean);

  return sections.join("\n\n") || null;
}
