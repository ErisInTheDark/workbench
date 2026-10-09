/*
 * Exports:
 * - ManagedThreadInstructionContext: managed prompt context plus the model used for selector filtering.
 * - WorkbenchManagedThreadInstructions: filtered base and developer instructions for one managed thread.
 * - createManagedThreadFilter: bind one managed caller's selectors, audience-visible tools (which gate `<docs>`), and workspace/setting facts.
 * - buildWorkbenchManagedThreadInstructions: assemble and filter managed base and developer instructions.
 * - buildWorkbenchManagedThreadActivatedSkills: assemble and filter activated skill bodies for one managed thread.
 */
import type { WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { filterWorkbenchInstructionContent, formatWorkbenchInstructionFilterWarning } from "./instruction-context-filter";
import { resolveWorkbenchInstructionToolReference, type WorkbenchInstructionTool } from "./instruction-tool-reference";
import type { InstructionSourceSpan } from "./instruction-file-generation";
import { listWorkbenchInstructionMechanics } from "./workbench-instruction-mechanics";
import { loadWorkbenchPromptAssembly } from "./workbench-prompt-generation";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";
import { isWorkbenchToolVisibleTo } from "workbench-shared/workbench/commands/workbench-tool-audience";

export interface ManagedThreadInstructionContext extends WorkbenchPromptContext {
  readonly harness: WorkbenchHarness;
  readonly model: string | null;
  readonly readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
}

export interface WorkbenchManagedThreadInstructions {
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
}

export async function createManagedThreadFilter(
  context: ManagedThreadInstructionContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
) {
  const catalogue = (await context.readInstructionTools()).filter(tool => (
    isWorkbenchToolVisibleTo(tool.id, Boolean(context.subagentName?.trim()))
  ));
  const facts = await listWorkbenchInstructionMechanics(context, readLocalCapabilities);
  return (value: string | null, field: string, sources: readonly InstructionSourceSpan[] = []) => (
    filterWorkbenchInstructionContent(value, {
      facts,
      field,
      harness: context.harness,
      model: context.model,
      onWarning: warning => process.stderr.write(`${formatWorkbenchInstructionFilterWarning(warning)}\n`),
      resolveTool: id => resolveWorkbenchInstructionToolReference(id, context.harness, catalogue),
      shell: process.platform === "win32" ? "pwsh" : "bash",
      sourceSections: value ? [{ content: value, sources }] : undefined,
    })
  );
}

export async function buildWorkbenchManagedThreadInstructions(
  context: ManagedThreadInstructionContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
): Promise<WorkbenchManagedThreadInstructions> {
  const filter = await createManagedThreadFilter(context, readLocalCapabilities);
  const instructions = await (await loadWorkbenchPromptAssembly()).buildWorkbenchPromptInstructions(context);
  return {
    baseInstructions: filter(instructions.baseInstructions, "baseInstructions", instructions.baseInstructionSources),
    developerInstructions: filter(instructions.developerInstructions, "developerInstructions"),
  };
}

export async function buildWorkbenchManagedThreadActivatedSkills(
  context: ManagedThreadInstructionContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
): Promise<string | null> {
  const filter = await createManagedThreadFilter(context, readLocalCapabilities);
  return filter(
    await (await loadWorkbenchPromptAssembly()).buildWorkbenchActivatedSkillCatalog(context),
    "input.wb:activated-skills",
  );
}
