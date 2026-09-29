/*
 * Exports:
 * - renderWorkbenchSkillContent: render a selected skill through root-bounded instruction imports and overrides.
 */
import path from "node:path";
import type { WorkbenchSkillDefinition } from "workbench-shared/types";
import { createInstructionFileGeneration } from "./instruction-file-generation";

export function renderWorkbenchSkillContent(skill: Pick<WorkbenchSkillDefinition, "path" | "relativePath">) {
  const relativePath = skill.relativePath.replaceAll("\\", "/");
  const segments = relativePath.split("/").filter(Boolean);
  let rootPath = path.resolve(skill.path);
  for (let remaining = segments.length; remaining > 0; remaining -= 1) rootPath = path.dirname(rootPath);
  return createInstructionFileGeneration({ rootPath, scopeLabel: "the selected skill source" }).render(relativePath);
}
