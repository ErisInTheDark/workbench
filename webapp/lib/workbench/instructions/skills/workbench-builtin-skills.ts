/*
 * Exports:
 * - readWorkbenchBuiltinSkills/readWorkbenchSkillTriggerAndPrecedenceInstructions: load current builtin skill and precedence Markdown. Keywords: skills, builtin, registry.
 */

import { readInstructionSource } from "../instruction-source";
import type { WorkbenchBuiltinSkillDefinition } from "./workbench-builtin-skill-types";

export function readWorkbenchSkillTriggerAndPrecedenceInstructions() {
  return readInstructionSource("skills/workbench-skill-precedence.md");
}

export function readWorkbenchBuiltinSkills(): readonly WorkbenchBuiltinSkillDefinition[] {
  return [{
    name: "browse",
    relativePath: "skills/builtin/browse/SKILL.md",
    content: readInstructionSource("skills/browse-builtin-skill.md"),
  }];
}
