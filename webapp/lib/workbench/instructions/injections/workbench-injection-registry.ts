/*
 * Exports:
 * - WORKBENCH_INJECTION_TEMPLATES: module-cached Markdown template registry for AGENTS placeholder expansion. Keywords: prompt, injection, registry.
 */

import { readInstructionSource } from "../instruction-source";
import { WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS } from "../skills/workbench-builtin-skills";
import { injectionTemplate, type InstructionInjectionTemplate } from "./instruction-injection-template";

const AGENT_DEFINITION_INJECTION = injectionTemplate(
  "agent.definition",
  "Selected Workbench agent identity. Workbench expands this slot to the resolved full agent definition.",
  readInstructionSource("injections/agent-definition-injection.md"),
);
const SUBAGENT_IDENTITY_INJECTION = injectionTemplate(
  "subagent.identity",
  "Optional Workbench-owned subagent name, emitted immediately after the selected agent identity.",
  readInstructionSource("injections/subagent-identity-injection.md"),
);
const WORKFLOW_ACTIVE_INJECTION = injectionTemplate(
  "workflow.active",
  "Workflow instructions selected or triggered for this thread. Active workflows define process for the current task without becoming universal base behavior.",
  readInstructionSource("injections/workflow-active-injection.md"),
);
const WORKBENCH_RENDERING_INJECTION = injectionTemplate(
  "workbench.rendering",
  "Workbench-visible markdown, mode-state, plan, questionnaire-context, and clickable file-link instructions.",
  readInstructionSource("injections/workbench-rendering-injection.md"),
);
const WORKBENCH_TOOLS_INJECTION = injectionTemplate(
  "workbench.tools",
  "Workbench-specific tool guidance, including structured user input, browser/MCP availability, and local harness preferences.",
  readInstructionSource("injections/workbench-tools-injection.md"),
);
const WORKSPACE_ROOTS_INJECTION = injectionTemplate(
  "workspace.roots",
  "Dynamic workspace root list and path/cwd expectations for multi-project Workbench threads.",
  readInstructionSource("injections/workspace-roots-injection.md"),
);
const WORKBENCH_SKILLS_INJECTION = injectionTemplate(
  "workbench.skills",
  "Detected Workbench skill manifest and trigger rules. Skill files are active when their trigger conditions match.",
  readInstructionSource("injections/workbench-skills-injection.md")
    .replaceAll("{{skill.precedence}}", WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS),
);

export const WORKBENCH_INJECTION_TEMPLATES = {
  ...AGENT_DEFINITION_INJECTION,
  ...SUBAGENT_IDENTITY_INJECTION,
  ...WORKFLOW_ACTIVE_INJECTION,
  ...WORKBENCH_RENDERING_INJECTION,
  ...WORKBENCH_TOOLS_INJECTION,
  ...WORKSPACE_ROOTS_INJECTION,
  ...WORKBENCH_SKILLS_INJECTION,
} as const satisfies InstructionInjectionTemplate;
