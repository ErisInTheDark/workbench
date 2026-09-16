/*
 * Exports:
 * - WorkbenchPromptContext: prompt assembly input and installed capabilities.
 * - WorkbenchPromptInstructions: assembled base and developer instructions.
 */

import type { WorkbenchHarness, WorkbenchProjectRoot } from "workbench-shared/types";
import type { InstructionSourceSpan } from "./instruction-file-generation";

export interface WorkbenchPromptContext {
  readonly agentPath?: string | null;
  readonly cwd?: string | null;
  readonly harness?: WorkbenchHarness | null;
  readonly skillCatalogPresentation?: "references" | "bodies";
  readonly managedThread?: boolean;
  readonly instructionScope?: "full" | "threadUtilities";
  readonly instructionInjections?: Readonly<Record<string, string>>;
  readonly activatedSkillPaths?: readonly string[];
  readonly projectId?: string | null;
  readonly roots?: readonly WorkbenchProjectRoot[];
  readonly subagentName?: string | null;
  readonly threadId?: string | null;
  readonly workbenchOrigin?: string | null;
  readonly workflowIds?: readonly string[];
}

export interface WorkbenchPromptInstructions {
  readonly baseInstructions: string | null;
  readonly baseInstructionSources?: readonly InstructionSourceSpan[];
  readonly developerInstructions: string | null;
}
