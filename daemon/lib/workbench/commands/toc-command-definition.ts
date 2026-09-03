/*
 * Exports:
 * - WorkbenchTocExecutionRequestSchema: validate cwd-owned Markdown heading index requests. Keywords: toc, markdown, headings, ranges, cwd.
 * - WORKBENCH_TOC_COMMANDS: expose Markdown heading ranges through the shared wb CLI and typed MCP registry. Keywords: toc, markdown, MCP, CLI.
 */
import { z } from "zod";

import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const markdownFilePath = z.string()
  .trim()
  .min(1)
  .max(32_768)
  .regex(/\.md(?:own)?$/iu)
  .describe("Markdown file path.");

export const WorkbenchTocExecutionRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  file: markdownFilePath,
}).strict();

const toc = defineWorkbenchAgentCommand({
  description: "List Markdown headings with their section line ranges.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["toc"],
  mcpCodeModeEligible: true,
  words: ["toc"],
  usage: "wb toc <file>",
  inputSchema: z.object({ file: markdownFilePath }).strict(),
  parseCliArgs(args) {
    if (args.length !== 1) throw new Error("wb toc requires one Markdown file path.");
    return { file: args[0] };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/api/toc", { cwd, file: input.file });
  },
});

export const WORKBENCH_TOC_COMMANDS = [toc] as const;
