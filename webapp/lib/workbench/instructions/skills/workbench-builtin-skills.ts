/*
 * Exports:
 * - WORKBENCH_BUILTIN_SKILLS/WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS: module-cached builtin skill and precedence Markdown. Keywords: skills, builtin, registry.
 */

import { readInstructionSource } from "../instruction-source";
import type { WorkbenchBuiltinSkillDefinition } from "./workbench-builtin-skill-types";

const WORKBENCH_BROWSE_BUILTIN_SKILL = readInstructionSource("skills/browse-builtin-skill.md");
export const WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS = readInstructionSource("skills/workbench-skill-precedence.md");

export const WORKBENCH_BUILTIN_SKILLS: readonly WorkbenchBuiltinSkillDefinition[] = [
  {
    name: "browse",
    relativePath: "skills/builtin/browse/SKILL.md",
    content: WORKBENCH_BROWSE_BUILTIN_SKILL,
  },
];
