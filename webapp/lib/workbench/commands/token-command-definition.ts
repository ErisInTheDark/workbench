/*
 * Exports:
 * - WorkbenchTokenCountExecutionRequestSchema: validate direct text and caller-aware instruction token requests. Keywords: tokens, instructions, command, cwd, thread.
 * - WORKBENCH_TOKEN_COMMANDS: expose exact model token counting through CLI and typed MCP definitions. Keywords: tokens, OpenAI, MCP, CLI.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const DEFAULT_MODEL = "gpt-5.6";
const model = z.string().trim().min(1).max(200).default(DEFAULT_MODEL).describe("OpenAI model whose tokenizer must count the text.");
const text = z.string().min(1).max(2 * 1024 * 1024).describe("Exact text to count.");
const cwd = z.string().trim().min(1);
const callerThreadId = z.string().trim().min(1).max(4096).nullable();

export const WorkbenchTokenCountExecutionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ cwd, kind: z.literal("text"), model, text }).strict(),
  z.object({ callerThreadId, cwd, kind: z.literal("instructions"), model }).strict(),
]);

const countText = defineWorkbenchAgentCommand({
  description: "Count exact text with OpenAI's model-specific input token counter.",
  effects: { idempotent: true, openWorld: true, readOnly: true },
  helpGroups: ["tokens"],
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
  description: "Count stripped Workbench runtime instruction text with OpenAI's model-specific input token counter.",
  effects: { idempotent: true, openWorld: true, readOnly: true },
  helpGroups: ["tokens"],
  managedThreadRootOnly: true,
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

export const WORKBENCH_TOKEN_COMMANDS = [countText, countInstructions] as const;
