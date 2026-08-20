/*
 * Exports:
 * - Workbench prompt source constants: generation-cached Markdown for generated agents, base prompts, workflows, and collaboration overlay. Keywords: prompts, markdown, sources.
 */

import { readInstructionSource } from "../instruction-source";

export const WORKBENCH_AGENT_DEFAULT_PROMPT = readInstructionSource("agents/default-agent-prompt.md");
export const WORKBENCH_AGENT_DEFAULT_TEMPLATE_PROMPT = readInstructionSource("agents/default-agent-template-prompt.md");
export const WORKBENCH_AGENTS_PROMPT = readInstructionSource("base/workbench-agents-prompt.md");
export const WORKBENCH_AGENTS_TEMPLATE_PROMPT = readInstructionSource("base/workbench-agents-template-prompt.md");
export const WORKBENCH_COLLABORATION_MODE_INSTRUCTIONS = readInstructionSource("overlays/workbench-collaboration-mode-instructions.md");
export const WORKBENCH_WORKFLOW_DEFAULT_PROMPT = readInstructionSource("workflows/default-workflow-prompt.md");
export const WORKBENCH_WORKFLOW_DEFAULT_TEMPLATE_PROMPT = readInstructionSource("workflows/default-workflow-template-prompt.md");
export const WORKBENCH_WORKFLOW_SUBAGENT_PROMPT = readInstructionSource("workflows/subagent-workflow-prompt.md");
export const WORKBENCH_WORKFLOW_SUBAGENT_TEMPLATE_PROMPT = readInstructionSource("workflows/subagent-workflow-template-prompt.md");
