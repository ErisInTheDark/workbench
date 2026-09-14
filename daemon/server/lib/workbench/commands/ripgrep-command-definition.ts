/*
 * Exports:
 * - WorkbenchRipgrepExecutionRequestSchema: validate the trusted-cwd ripgrep execution boundary. Keywords: ripgrep, search, command, cwd.
 * - WORKBENCH_RIPGREP_COMMANDS: expose ripgrep through the shared wb CLI and typed MCP registry. Keywords: ripgrep, search, MCP, CLI.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const ripgrepArguments = z.array(z.string().max(65_536)).min(1).max(256).describe(
  "Native ripgrep arguments. Pass each argument as one array item. No matches return successful empty output. --pre and --hostname-bin are unavailable because this tool is read-only.",
);

export const WorkbenchRipgrepExecutionRequestSchema = z.object({
  args: ripgrepArguments,
  cwd: z.string().trim().min(1),
}).strict();

const ripgrep = defineWorkbenchAgentCommand({
  description: "Search with native ripgrep arguments without shell quoting; no matches are successful empty output.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["rg"],
  mcpCodeModeEligible: true,
  words: ["rg"],
  usage: "wb rg -- <rg args>",
  inputSchema: z.object({ args: ripgrepArguments }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { trailing: true });
    return { args: flags.trailing };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/api/rg", { args: input.args, cwd });
  },
});

export const WORKBENCH_RIPGREP_COMMANDS = [ripgrep] as const;
