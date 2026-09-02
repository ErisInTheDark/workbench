/*
 * Exports:
 * - LibraryInstructionFile/LibraryInstructionFileGeneration: Workbench Library aliases for generic per-generation instruction contracts. Keywords: instructions, library, imports, generation.
 * - createLibraryInstructionFileGeneration: create a fresh instruction graph rooted at the Workbench Library. Keywords: instructions, library, generation.
 */

import { workbenchLibraryRoot } from "../../workbench-library-paths";
import {
  createInstructionFileGeneration,
  type InstructionFile,
  type InstructionFileGeneration,
} from "./instruction-file-generation";

export type LibraryInstructionFile = InstructionFile;
export type LibraryInstructionFileGeneration = InstructionFileGeneration;

interface LibraryInstructionFileGenerationOptions {
  readonly rootPath?: string;
}

export function createLibraryInstructionFileGeneration(
  options: LibraryInstructionFileGenerationOptions = {},
): LibraryInstructionFileGeneration {
  return createInstructionFileGeneration({
    rootPath: options.rootPath ?? workbenchLibraryRoot,
    scopeLabel: "the Workbench Library",
  });
}
