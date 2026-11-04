/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions/WorkbenchActivatedSkillCatalog/WorkbenchSkillLayer: stable prompt assembly contracts.
 * - ensure/build Workbench prompt functions: delegate each source-consuming call through the current assembly generation, refreshed after source edits.
 * - listWorkbenchPromptSkills: the skill catalog entries a build would list now.
 * - buildWorkbenchActivatedSkillCatalog: load fresh bodies for validated slash-activated skills, with each body's declared layer.
 * - buildWorkbenchManagedThreadInstructions/buildWorkbenchManagedThreadActivatedSkills: shared managed-thread instruction and activated-skill assembly with one filtering pipeline.
 * - filterWorkbenchInstructionContent/listWorkbenchInstructionMechanics: final selector filtering and capability-backed availability helpers.
 * - default WorkbenchPromptFiles: stable public prompt API.
 */

import { filterWorkbenchInstructionContent } from "./instruction-context-filter";
import { listWorkbenchInstructionMechanics } from "./workbench-instruction-mechanics";
import { loadWorkbenchPromptAssembly } from "./workbench-prompt-generation";
import type { WorkbenchActivatedSkillCatalog, WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";

export type { WorkbenchActivatedSkillCatalog, WorkbenchPromptContext, WorkbenchPromptInstructions, WorkbenchSkillLayer } from "./workbench-prompt-types";
export {
  buildWorkbenchManagedThreadActivatedSkills,
  buildWorkbenchManagedThreadInstructions,
} from "./workbench-managed-thread-instructions";
export { WorkbenchInstructionPrefixContextSchema } from "./workbench-managed-thread-instructions";
export type {
  ManagedThreadInstructionContext,
  WorkbenchInstructionPrefix,
  WorkbenchInstructionPrefixContext,
  WorkbenchManagedThreadActivatedSkills,
  WorkbenchManagedThreadInstructions,
} from "./workbench-managed-thread-instructions";
export { filterWorkbenchInstructionContent, listWorkbenchInstructionMechanics };

export async function ensureWorkbenchPromptFiles() {
  await (await loadWorkbenchPromptAssembly()).ensureWorkbenchPromptFiles();
}

export async function buildWorkbenchPromptInstructions(
  context: WorkbenchPromptContext = {},
): Promise<WorkbenchPromptInstructions> {
  return await (await loadWorkbenchPromptAssembly()).buildWorkbenchPromptInstructions(context);
}

export async function listWorkbenchPromptSkills(context: WorkbenchPromptContext = {}) {
  return await (await loadWorkbenchPromptAssembly()).listWorkbenchPromptSkills(context);
}

export async function buildWorkbenchActivatedSkillCatalog(
  context: WorkbenchPromptContext = {},
): Promise<WorkbenchActivatedSkillCatalog> {
  return await (await loadWorkbenchPromptAssembly()).buildWorkbenchActivatedSkillCatalog(context);
}

export async function buildWorkbenchThreadUtilityDeveloperInstructions(
  context: WorkbenchPromptContext = {},
) {
  return await (await loadWorkbenchPromptAssembly()).buildWorkbenchThreadUtilityDeveloperInstructions(context);
}

const WorkbenchPromptFiles = {
  buildWorkbenchActivatedSkillCatalog,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
