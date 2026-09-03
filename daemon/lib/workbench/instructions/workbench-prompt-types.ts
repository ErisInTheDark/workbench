/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions: prompt assembly input and output contracts. Keywords: prompt, context, instructions.
 */

import type { WorkbenchHarness, WorkbenchProjectRoot } from "workbench-shared/types";

export interface WorkbenchPromptContext {
  readonly agentPath?: string | null;
  readonly cwd?: string | null;
  readonly harness?: WorkbenchHarness | null;
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
  readonly developerInstructions: string | null;
}
