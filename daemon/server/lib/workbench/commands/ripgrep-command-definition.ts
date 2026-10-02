/*
 * Exports:
 * - WorkbenchRipgrepExecutionRequestSchema: validate the trusted-cwd wb rg request boundary.
 * - WORKBENCH_RIPGREP_COMMANDS: expose the rg-compatible search through the shared wb CLI and typed MCP registry.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const ripgrepArguments = z.array(z.string().max(65_536)).min(1).max(256).describe(
  "rg-style arguments, one per array item; regex is JavaScript syntax. Gitignored files are skipped even under explicit paths unless --no-ignore. Output stops at --max-results (default 500, 0 = unlimited); files over --max-filesize (default 4M) are skipped. --help lists supported flags. No matches return successful empty output.",
);

export const WorkbenchRipgrepExecutionRequestSchema = z.object({
  args: ripgrepArguments,
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
}).strict();

const ripgrep = defineWorkbenchAgentCommand({
  description: "Search project files with rg-style arguments without shell quoting; gitignored files are skipped by default and no matches are successful empty output.",
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
  buildRequest(input, { cwd, callerHarness }) {
    return postWorkbenchAgentCommand("/api/rg", { args: input.args, cwd, harness: callerHarness });
  },
});

export const WORKBENCH_RIPGREP_COMMANDS = [ripgrep] as const;
