/*
 * Exports:
 * - readWorkbenchProofOfWorkCatalogue: every proof-of-work checklist a Workbench agent in one project can be given.
 */
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import { ensureWorkbenchLibrary, listActiveWorkbenchSkillDefinitions, listWorkbenchLibraryInstructions } from "../../workbench-library";
import { listProjectSkillsFromRoot } from "../project/project-agents-folder";
import { EMPTY_PROJECT_SKILLS } from "../skills/skill-discovery";
import { collectWorkbenchInstructionProofOfWork } from "./instruction-context-filter";
import { createLibraryInstructionFileGeneration } from "./library-instruction-files";
import { buildProjectInstructionContent } from "./project-instruction-files";
import { renderWorkbenchSkillContent } from "./skill-rendering";

/** Reads sources unfiltered: checklists cannot hold selectors, so each declared family is the same for every caller. */
export async function readWorkbenchProofOfWorkCatalogue(projectRoot: string | null): Promise<ProofOfWorkChecklist[]> {
  await ensureWorkbenchLibrary();
  const instructionFiles = createLibraryInstructionFileGeneration();
  const [skills, packs] = await Promise.all([
    listActiveWorkbenchSkillDefinitions(projectRoot ? await listProjectSkillsFromRoot(projectRoot) : EMPTY_PROJECT_SKILLS),
    listWorkbenchLibraryInstructions(),
  ]);
  const sources = [
    instructionFiles.render("AGENTS.md"),
    ...instructionFiles.list("wb/workflows").map(workflow => instructionFiles.render(workflow.relativePath)),
    ...packs.map(pack => pack.content),
    projectRoot ? buildProjectInstructionContent({ cwd: projectRoot, roots: [{ rootPath: projectRoot }] }) ?? "" : "",
    ...skills.map(skill => renderWorkbenchSkillContent(skill)),
  ];
  const checklists = new Map<string, ProofOfWorkChecklist>();
  for (const checklist of sources.flatMap(collectWorkbenchInstructionProofOfWork)) {
    if (checklists.has(checklist.id)) console.warn(`[proof-of-work] Checklist ${checklist.id} is declared more than once; the first declaration wins.`);
    else checklists.set(checklist.id, checklist);
  }
  return [...checklists.values()];
}
