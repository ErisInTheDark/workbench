/*
 * Keywords: tokens, instructions, project, MCP, CLI.
 * Exports:
 * - WorkbenchTokenCountExecutionRequestSchema: validate direct text, Workbench-source, and cwd-owned project instruction token requests. Keywords: tokens, instructions, project, cwd, thread.
 * - WORKBENCH_TOKEN_COMMANDS: expose exact local GPT-5 text and instruction counting through CLI and typed MCP definitions. Keywords: tokens, GPT-5, project, MCP, CLI.
 */
import { z } from "zod";

import Gpt5TextTokens from "./gpt-5-text-tokens";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const DEFAULT_MODEL = "gpt-5.6";
const model = z.string().trim().min(1).max(200)
  .refine(Gpt5TextTokens.supports, "A GPT-5-family model is required.")
  .default(DEFAULT_MODEL)
  .describe("GPT-5-family model whose o200k_base tokenizer must count the text.");
const text = z.string().min(1).max(2 * 1024 * 1024).describe("Exact text to count.");
const cwd = z.string().trim().min(1);
const callerThreadId = z.string().trim().min(1).max(4096).nullable();

export const WorkbenchTokenCountExecutionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ cwd, kind: z.literal("text"), model, text }).strict(),
  z.object({ callerThreadId, cwd, kind: z.literal("instructions"), model }).strict(),
  z.object({ cwd, kind: z.literal("projectInstructions"), model }).strict(),
]);

const countText = defineWorkbenchAgentCommand({
  description: "Count standalone text locally.",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  helpGroups: ["tokens"],
  mcpCodeModeEligible: true,
  words: ["tokens"],
  usage: "wb tokens [--model <model>] -- <text>",
  inputSchema: z.object({ model, text }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { trailing: true, values: ["--model"] });
    if (flags.trailing.length !== 1) throw new Error("Pass one exact text value after --.");
    return { model: flags.optional("--model") ?? DEFAULT_MODEL, text: flags.trailing[0] };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/tokens", { cwd, kind: "text", model: input.model, text: input.text });
  },
});

const countInstructions = defineWorkbenchAgentCommand({
  description: "Count actual tokens provided to agents in Workbench instructions. Strips HTML comments. Use over `tokens` when applicable. Count -> patch -> count",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  helpGroups: ["tokens"],
  managedThreadRootOnly: true,
  mcpCodeModeEligible: true,
  words: ["tokens", "instructions"],
  usage: "wb tokens instructions [--model <model>]",
  inputSchema: z.object({ model }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--model"] });
    return { model: flags.optional("--model") ?? DEFAULT_MODEL };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/internal/tokens", { callerThreadId, cwd, kind: "instructions", model: input.model });
  },
});

const countProjectInstructions = defineWorkbenchAgentCommand({
  description: "Count actual tokens provided to agents in the current project via the AGENTS.md and its imports. Strips HTML comments. Use over `tokens` when applicable. Count -> patch -> count",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  helpGroups: ["tokens"],
  mcpCodeModeEligible: true,
  words: ["tokens", "project"],
  usage: "wb tokens project [--model <model>]",
  inputSchema: z.object({ model }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--model"] });
    return { model: flags.optional("--model") ?? DEFAULT_MODEL };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/tokens", { cwd, kind: "projectInstructions", model: input.model });
  },
});

export const WORKBENCH_TOKEN_COMMANDS = [countText, countInstructions, countProjectInstructions] as const;
