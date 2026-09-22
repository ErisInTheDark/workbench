/*
 * Exports:
 * - WorkbenchTokenCountExecutionRequestSchema: validate text and source-aware instruction token requests.
 * - WORKBENCH_TOKEN_COMMANDS: expose local GPT-5 token counting through CLI and typed MCP definitions.
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
const toc = z.boolean().optional().describe("Include source-file and Markdown heading token counts.");
const cwd = z.string().trim().min(1);
const callerThreadId = z.string().trim().min(1).max(4096).nullable();

export const WorkbenchTokenCountExecutionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ cwd, kind: z.literal("text"), model, text }).strict(),
  z.object({ callerThreadId, cwd, kind: z.literal("instructions"), model, toc }).strict(),
  z.object({ cwd, kind: z.literal("projectInstructions"), model, toc }).strict(),
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
  usage: "wb tokens instructions [--toc] [--model <model>]",
  inputSchema: z.object({ model, toc }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--toc"], values: ["--model"] });
    return {
      model: flags.optional("--model") ?? DEFAULT_MODEL,
      ...(flags.has("--toc") ? { toc: true } : {}),
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/internal/tokens", {
      callerThreadId,
      cwd,
      kind: "instructions",
      model: input.model,
      ...(input.toc ? { toc: true } : {}),
    });
  },
});

const countProjectInstructions = defineWorkbenchAgentCommand({
  description: "Count actual tokens provided to agents in the current project via the AGENTS.md and its imports. Strips HTML comments. Use over `tokens` when applicable. Count -> patch -> count",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  helpGroups: ["tokens"],
  mcpCodeModeEligible: true,
  words: ["tokens", "project"],
  usage: "wb tokens project [--toc] [--model <model>]",
  inputSchema: z.object({ model, toc }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--toc"], values: ["--model"] });
    return {
      model: flags.optional("--model") ?? DEFAULT_MODEL,
      ...(flags.has("--toc") ? { toc: true } : {}),
    };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/tokens", {
      cwd,
      kind: "projectInstructions",
      model: input.model,
      ...(input.toc ? { toc: true } : {}),
    });
  },
});

export const WORKBENCH_TOKEN_COMMANDS = [countText, countInstructions, countProjectInstructions] as const;
