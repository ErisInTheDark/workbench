/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions: stable prompt assembly contracts. Keywords: prompt, context, instructions.
 * - ensure/build Workbench prompt functions: delegate each source-consuming call through one fresh assembly generation. Keywords: prompt, markdown, reload.
 * - buildWorkbenchActivatedSkillCatalog: load fresh bodies for validated slash-activated skills. Keywords: skills, slash, input.
 * - buildWorkbenchManagedThreadInstructions/buildWorkbenchManagedThreadActivatedSkills: shared managed-thread instruction and activated-skill assembly with one filtering pipeline. Keywords: managed, filter, providers.
 * - filterWorkbenchInstructionContent/listWorkbenchInstructionMechanics: final selector filtering and capability-backed availability helpers. Keywords: selector, mechanics.
 * - default WorkbenchPromptFiles: stable public prompt API. Keywords: prompt, owner, generation.
 */

import { filterWorkbenchInstructionContent } from "./instruction-context-filter";
import { listWorkbenchInstructionMechanics } from "./workbench-instruction-mechanics";
import { loadFreshWorkbenchPromptAssembly } from "./workbench-prompt-generation";
import type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";

export type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";
export {
  buildWorkbenchManagedThreadActivatedSkills,
  buildWorkbenchManagedThreadInstructions,
} from "./workbench-managed-thread-instructions";
export type {
  ManagedThreadInstructionContext,
  WorkbenchManagedThreadInstructions,
} from "./workbench-managed-thread-instructions";
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

const WorkbenchPromptFiles = {
  buildWorkbenchActivatedSkillCatalog,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
