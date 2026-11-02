/*
 * Exports:
 * - WorkbenchInstructionOverlays: the proof checklists and workflow modes one agent's instruction layers resolve to.
 * - resolveWorkbenchInstructionOverlays: replay ordered instruction sources so a later declaration replaces an earlier one by name.
 * - readWorkbenchInstructionOverlays: read one project's or one thread's instruction layers and resolve them.
 */
import path from "node:path";
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import type { WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
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

/** Sources run from base to top layer; mode names match case-insensitively, as agents switch with them. */
export function resolveWorkbenchInstructionOverlays(sources: readonly string[]): WorkbenchInstructionOverlays {
  const checklists = new Map<string, ProofOfWorkChecklist>();
  const modes = new Map<string, WorkflowMode>();
  for (const source of sources) {
    for (const checklist of collectWorkbenchInstructionProofOfWork(source)) {
      checklists.delete(checklist.id);
      checklists.set(checklist.id, checklist);
    }
    for (const mode of collectWorkbenchInstructionModes(source)) {
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

/**
 * Layers: Workbench AGENTS.md and instruction packs, then workflows, then the project's AGENTS.md/AGENTS.local.md chain,
 * then skills. A thread names its selected workflows and active skills in activation order; without a thread, every
 * workflow and available skill counts, so project-wide reads cover whatever a thread there can be given.
 */
export async function readWorkbenchInstructionOverlays({ projectRoot, thread }: {
  projectRoot: string | null;
  thread?: { workflowIds: readonly string[]; skillPaths: readonly string[] };
}): Promise<WorkbenchInstructionOverlays> {
  await ensureWorkbenchLibrary();
  const instructionFiles = createLibraryInstructionFileGeneration();
  const [available, packs] = await Promise.all([
    listActiveWorkbenchSkillDefinitions(projectRoot ? await listProjectSkillsFromRoot(projectRoot) : EMPTY_PROJECT_SKILLS),
    listWorkbenchLibraryInstructions(),
  ]);
  const selected = thread ? new Set(thread.workflowIds.map(id => id.trim().toLowerCase())) : null;
  const workflows = instructionFiles.list("wb/workflows").filter(workflow => !selected || selected.has(workflow.key));
  const skills = thread
    ? thread.skillPaths.flatMap(skillPath => available.filter(skill => samePath(skill.path, skillPath)).slice(0, 1))
    : available;
  return resolveWorkbenchInstructionOverlays([
    instructionFiles.render("AGENTS.md"),
    ...packs.map(pack => pack.content),
    ...workflows.map(workflow => instructionFiles.render(workflow.relativePath)),
    projectRoot ? buildProjectInstructionContent({ cwd: projectRoot, roots: [{ rootPath: projectRoot }] }) ?? "" : "",
    ...skills.map(skill => renderWorkbenchSkillContent(skill)),
  ]);
}
