/*
 * Exports:
 * - ManagedThreadInstructionContext: managed prompt context plus the model used for selector filtering.
 * - WorkbenchManagedThreadInstructions: filtered base and developer instructions for one managed thread, with the layers they declare.
 * - WorkbenchManagedThreadActivatedSkills: filtered activated skill bodies, with each body's declared layer.
 * - createManagedThreadFilter: bind one managed caller's selectors, audience-visible, capability-enabled tools (which gate `<docs>`), and workspace facts.
 * - buildWorkbenchManagedThreadInstructions: assemble and filter managed base and developer instructions.
 * - buildWorkbenchManagedThreadActivatedSkills: assemble and filter activated skill bodies for one managed thread.
 */
import type { WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { filterWorkbenchInstructionContent, formatWorkbenchInstructionFilterWarning } from "./instruction-context-filter";
import {
  resolveWorkbenchInstructionToolReference,
  selectWorkbenchInstructionTools,
  servesWorkbenchInstructionTool,
  type WorkbenchInstructionTool,
} from "./instruction-tool-reference";
import type { InstructionSourceSpan } from "./instruction-file-generation";
import type { WorkbenchInstructionOverlays } from "./instruction-overlay-catalogue";
import type { WorkbenchSkillLayer } from "./workbench-prompt-types";
import { listWorkbenchInstructionMechanics, readWorkbenchInstructionCapabilities } from "./workbench-instruction-mechanics";
import { loadWorkbenchPromptAssembly } from "./workbench-prompt-generation";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";

export interface ManagedThreadInstructionContext extends WorkbenchPromptContext {
  readonly harness: WorkbenchHarness;
  readonly model: string | null;
  readonly readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
}

export interface WorkbenchManagedThreadInstructions {
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  /** What the unfiltered text declares, in prompt order; filtering only rewrites declarations into agent sentences. */
  readonly overlayLayers: readonly WorkbenchInstructionOverlays[];
}

export interface WorkbenchManagedThreadActivatedSkills {
  readonly catalog: string | null;
  readonly skillLayers: readonly WorkbenchSkillLayer[];
}

export async function createManagedThreadFilter(
  context: ManagedThreadInstructionContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
) {
  const [tools, capabilities] = await Promise.all([
    context.readInstructionTools(),
    readWorkbenchInstructionCapabilities(readLocalCapabilities),
  ]);
  const catalogue = selectWorkbenchInstructionTools(
    tools, { harness: context.harness, subagent: Boolean(context.subagentName?.trim()) }, capabilities,
  );
  const facts = listWorkbenchInstructionMechanics(context);
  return (value: string | null, field: string, sources: readonly InstructionSourceSpan[] = []) => (
    filterWorkbenchInstructionContent(value, {
      facts,
      field,
      harness: context.harness,
      model: context.model,
      onWarning: warning => process.stderr.write(`${formatWorkbenchInstructionFilterWarning(warning)}\n`),
      resolveTool: id => resolveWorkbenchInstructionToolReference(id, context.harness, catalogue),
      servesTool: id => servesWorkbenchInstructionTool(id, catalogue),
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
    overlayLayers: instructions.overlayLayers,
  };
}

export async function buildWorkbenchManagedThreadActivatedSkills(
  context: ManagedThreadInstructionContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
): Promise<WorkbenchManagedThreadActivatedSkills> {
  const filter = await createManagedThreadFilter(context, readLocalCapabilities);
  const { catalog, skillLayers } = await (await loadWorkbenchPromptAssembly()).buildWorkbenchActivatedSkillCatalog(context);
  return { catalog: filter(catalog, "input.wb:activated-skills"), skillLayers };
}
