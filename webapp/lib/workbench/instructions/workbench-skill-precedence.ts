/*
 * Exports:
 * - WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS: canonical Workbench skill trigger and source-precedence instructions. Keywords: skills, trigger, precedence.
 */

export const WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS = `
Treat a skill as triggered when the user invokes it by slash command, name, or path; when its description or trigger rules clearly match the current request; or when another active skill or workflow explicitly calls for it.

Skill precedence only resolves duplicate or equivalent triggered skills from multiple sources, such as the same slash command, the same skill name, the same skill-path intent, or overlapping source copies of the same workflow. Do not use precedence to ignore unrelated skills that independently trigger for the same request; use each applicable unrelated skill unless their instructions conflict.

Before reading duplicate or equivalent triggered skills, choose the highest-precedence applicable source. Read and apply only that source, and do not read, merge, or apply lower-precedence copies unless the user explicitly requests a specific source or path. Apply this precedence from highest to lowest:

1. project skills
2. user \`.workbench/skills/<name>\` skills
3. user \`.agents\` folder skills
4. Workbench builtin skills under \`.workbench/skills/builtin/<name>\`
5. any other skills, using whatever other precedence instructions are present

Generated Workbench builtin skills are fallback defaults. A project skill or user Workbench skill with the same skill name, slash command, or path intent shadows the builtin skill.
`.trim();
