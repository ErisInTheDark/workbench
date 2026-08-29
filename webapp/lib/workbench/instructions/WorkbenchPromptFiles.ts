/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions: stable prompt assembly contracts. Keywords: prompt, context, instructions.
 * - ensure/build Workbench prompt functions: delegate each source-consuming call through one fresh assembly generation. Keywords: prompt, markdown, reload.
 * - buildWorkbenchActivatedSkillCatalog: load fresh bodies for validated slash-activated skills. Keywords: skills, slash, input.
 * - filterWorkbenchInstructionContent/listWorkbenchInstructionMechanics: source-free selector and availability helpers. Keywords: selector, mechanics.
 * - default WorkbenchPromptFiles: stable public prompt API. Keywords: prompt, owner, generation.
 */

import { loadFreshWorkbenchPromptAssembly } from "./assembly/workbench-prompt-generation";
import type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./assembly/workbench-prompt-types";
import { listWorkbenchInstructionMechanics } from "./mechanics/workbench-instruction-mechanics";
import { filterWorkbenchInstructionContent } from "./selectors/instruction-context-filter";

export type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./assembly/workbench-prompt-types";
export { filterWorkbenchInstructionContent, listWorkbenchInstructionMechanics };

export async function ensureWorkbenchPromptFiles() {
  await loadFreshWorkbenchPromptAssembly().ensureWorkbenchPromptFiles();
}

export async function buildWorkbenchPromptInstructions(
  context: WorkbenchPromptContext = {},
): Promise<WorkbenchPromptInstructions> {
  return await loadFreshWorkbenchPromptAssembly().buildWorkbenchPromptInstructions(context);
}

export async function buildWorkbenchActivatedSkillCatalog(
  context: WorkbenchPromptContext = {},
): Promise<string | null> {
  return await loadFreshWorkbenchPromptAssembly().buildWorkbenchActivatedSkillCatalog(context);
}

export async function buildWorkbenchThreadUtilityDeveloperInstructions(
  context: WorkbenchPromptContext = {},
) {
  return await loadFreshWorkbenchPromptAssembly().buildWorkbenchThreadUtilityDeveloperInstructions(context);
}

export async function buildWorkbenchCollaborationDeveloperInstructions(
  context: WorkbenchPromptContext = {},
) {
  return await loadFreshWorkbenchPromptAssembly().buildWorkbenchCollaborationDeveloperInstructions(context);
}

export function buildWorkbenchGitInstructions(context: WorkbenchPromptContext) {
  return loadFreshWorkbenchPromptAssembly().buildWorkbenchGitInstructions(context);
}

const WorkbenchPromptFiles = {
  buildWorkbenchActivatedSkillCatalog,
  buildWorkbenchCollaborationDeveloperInstructions,
  buildWorkbenchGitInstructions,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
