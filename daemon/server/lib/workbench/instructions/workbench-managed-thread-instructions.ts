/*
 * Exports:
 * - ManagedThreadInstructionContext: managed prompt context plus the model used for selector filtering.
 * - WorkbenchInstructionPrefixContextSchema/WorkbenchInstructionPrefixContext/WorkbenchInstructionPrefix: a build's serializable input and
 *   the fingerprint of the prefix it delivered, enough to rebuild and compare later.
 * - WorkbenchManagedThreadInstructions: filtered base and developer instructions for one managed thread, with the layers they declare and their prefix.
 * - WorkbenchManagedThreadActivatedSkills: filtered activated skill bodies, with each body's declared layer.
 * - createManagedThreadFilter: bind one managed caller's selectors, audience-visible, capability-enabled tools (which gate `<docs>`), and workspace facts.
 * - buildWorkbenchManagedThreadInstructions: assemble and filter managed base and developer instructions.
 * - buildWorkbenchManagedThreadActivatedSkills: assemble and filter activated skill bodies for one managed thread.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
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

/** The serializable part of a managed build's input: everything that shapes the prefix except live tool and capability reads. */
export const WorkbenchInstructionPrefixContextSchema = z.object({
  harness: ProviderKeySchema,
  model: z.string().nullable(),
  role: z.enum(["agent", "voice-to-text"]).optional(),
  agentPath: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  managedThread: z.boolean().optional(),
  instructionScope: z.enum(["full", "threadUtilities"]).optional(),
  instructionInjections: z.record(z.string(), z.string()).optional(),
  projectId: z.string().nullable().optional(),
  roots: z.array(z.object({
    id: z.string(), isPrimary: z.boolean(), name: z.string(), relativePath: z.string(), rootPath: z.string(),
  })).optional(),
  skills: z.array(z.object({ name: z.string(), trigger: z.string(), digest: z.string() })).optional(),
  subagentName: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  workbenchOrigin: z.string().nullable().optional(),
  workflowIds: z.array(z.string()).optional(),
});
export type WorkbenchInstructionPrefixContext = z.infer<typeof WorkbenchInstructionPrefixContextSchema>;

/** What a build delivered as the thread's prefix, and the input that rebuilds it. */
export interface WorkbenchInstructionPrefix {
  readonly hash: string;
  readonly context: WorkbenchInstructionPrefixContext;
}

export interface WorkbenchManagedThreadInstructions {
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  /** What the unfiltered text declares, in prompt order; filtering only rewrites declarations into agent sentences. */
  readonly overlayLayers: readonly WorkbenchInstructionOverlays[];
  /** Null when the input cannot be stored for a rebuild; such a thread is never reported stale. */
  readonly prefix: WorkbenchInstructionPrefix | null;
}

function readPrefixContext(context: ManagedThreadInstructionContext): WorkbenchInstructionPrefixContext | null {
  const { readInstructionTools: _tools, activatedSkillPaths: _skills, ...serializable } = context;
  const parsed = WorkbenchInstructionPrefixContextSchema.safeParse(JSON.parse(JSON.stringify(serializable)));
  return parsed.success ? parsed.data : null;
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
  const baseInstructions = filter(instructions.baseInstructions, "baseInstructions", instructions.baseInstructionSources);
  const developerInstructions = filter(instructions.developerInstructions, "developerInstructions");
  const prefixContext = readPrefixContext(context);
  return {
    baseInstructions,
    developerInstructions,
    overlayLayers: instructions.overlayLayers,
    prefix: prefixContext && {
      hash: createHash("sha256").update(baseInstructions ?? "").update("\0").update(developerInstructions ?? "").digest("hex"),
      context: prefixContext,
    },
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
