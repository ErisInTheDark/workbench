/*
 * Exports:
 * - WorkbenchInstructionOverlays: the proof checklists and workflow modes instruction layers resolve to; one source's own declarations form a layer.
 * - WorkbenchInstructionOverlaysSchema: validates a stored layer.
 * - readWorkbenchInstructionLayer: one instruction source's declared checklists and modes.
 * - mergeWorkbenchInstructionLayers: replay layers base to top so a later declaration replaces an earlier one by name.
 * - readWorkbenchSkillLayers: each listed active skill's layer, read from its current files.
 * - readWorkbenchInstructionBaseLayers: the layers every turn's prompt carries (AGENTS with workflows, packs, project chain), read from current files.
 * - readWorkbenchInstructionOverlays: one project's or one thread's layers, read from current files and merged.
 */
import path from "node:path";
import { z } from "zod";
import { ProofOfWorkChecklistSchema, type ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import { WorkflowModeSchema, type WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import { ensureWorkbenchLibrary, listActiveWorkbenchSkillDefinitions, listWorkbenchLibraryInstructions } from "../../workbench-library";
import { listProjectSkillsFromRoot } from "../project/project-agents-folder";
import { EMPTY_PROJECT_SKILLS } from "../skills/skill-discovery";
import { collectWorkbenchInstructionModes, collectWorkbenchInstructionProofOfWork } from "./instruction-context-filter";
import { createLibraryInstructionFileGeneration } from "./library-instruction-files";
import { buildProjectInstructionContent } from "./project-instruction-files";
import { renderWorkbenchSkillContent } from "./skill-rendering";

export interface WorkbenchInstructionOverlays {
  checklists: ProofOfWorkChecklist[];
  modes: WorkflowMode[];
}

export const WorkbenchInstructionOverlaysSchema = z.object({
  checklists: z.array(ProofOfWorkChecklistSchema),
  modes: z.array(WorkflowModeSchema),
}).strict();

export function readWorkbenchInstructionLayer(source: string): WorkbenchInstructionOverlays {
  return { checklists: collectWorkbenchInstructionProofOfWork(source), modes: collectWorkbenchInstructionModes(source) };
}

/** Mode names match case-insensitively, as agents switch with them. */
export function mergeWorkbenchInstructionLayers(layers: readonly WorkbenchInstructionOverlays[]): WorkbenchInstructionOverlays {
  const checklists = new Map<string, ProofOfWorkChecklist>();
  const modes = new Map<string, WorkflowMode>();
  for (const layer of layers) {
    for (const checklist of layer.checklists) {
      checklists.delete(checklist.id);
      checklists.set(checklist.id, checklist);
    }
    for (const mode of layer.modes) {
      const key = mode.name.toLowerCase();
      modes.delete(key);
      modes.set(key, mode);
    }
  }
  return { checklists: [...checklists.values()], modes: [...modes.values()] };
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

async function listSkills(projectRoot: string | null) {
  return await listActiveWorkbenchSkillDefinitions(projectRoot ? await listProjectSkillsFromRoot(projectRoot) : EMPTY_PROJECT_SKILLS);
}

/** Null paths read every available skill. */
export async function readWorkbenchSkillLayers(projectRoot: string | null, skillPaths: readonly string[] | null) {
  await ensureWorkbenchLibrary();
  const available = await listSkills(projectRoot);
  const skills = skillPaths
    ? skillPaths.flatMap(skillPath => available.filter(skill => samePath(skill.path, skillPath)).slice(0, 1))
    : available;
  return skills.map(skill => ({ path: skill.path, layer: readWorkbenchInstructionLayer(renderWorkbenchSkillContent(skill)) }));
}

/**
 * Prompt order: AGENTS.md with its workflows, instruction packs, then the project's AGENTS.md/AGENTS.local.md chain.
 * Null workflow ids include every workflow, so project-wide reads cover whatever a thread there can be given.
 */
export async function readWorkbenchInstructionBaseLayers({ projectRoot, workflowIds }: {
  projectRoot: string | null;
  workflowIds: readonly string[] | null;
}) {
  await ensureWorkbenchLibrary();
  const instructionFiles = createLibraryInstructionFileGeneration();
  const packs = await listWorkbenchLibraryInstructions();
  const selected = workflowIds ? new Set(workflowIds.map(id => id.trim().toLowerCase())) : null;
  const workflows = instructionFiles.list("wb/workflows").filter(workflow => !selected || selected.has(workflow.key));
  return [
    instructionFiles.render("AGENTS.md"),
    ...workflows.map(workflow => instructionFiles.render(workflow.relativePath)),
    ...packs.map(pack => pack.content),
    projectRoot ? buildProjectInstructionContent({ cwd: projectRoot, roots: [{ rootPath: projectRoot }] }) ?? "" : "",
  ].map(readWorkbenchInstructionLayer);
}

/** A thread names its selected workflows and active skills in activation order; without one, everything available counts. */
export async function readWorkbenchInstructionOverlays({ projectRoot, thread }: {
  projectRoot: string | null;
  thread?: { workflowIds: readonly string[]; skillPaths: readonly string[] };
}): Promise<WorkbenchInstructionOverlays> {
  const [base, skills] = await Promise.all([
    readWorkbenchInstructionBaseLayers({ projectRoot, workflowIds: thread?.workflowIds ?? null }),
    readWorkbenchSkillLayers(projectRoot, thread?.skillPaths ?? null),
  ]);
  return mergeWorkbenchInstructionLayers([...base, ...skills.map(skill => skill.layer)]);
}
