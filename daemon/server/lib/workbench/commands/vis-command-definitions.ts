/*
 * Exports:
 * - WorkbenchVisRequestSchema: validate one managed caller's vis session start or end.
 * - WORKBENCH_VIS_COMMANDS: `wb vis start` and `wb vis end`, shared by CLI and MCP.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const visPath = z.string().trim().min(1).max(1_000);
const caller = { cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1) };
export const WorkbenchVisRequestSchema = z.object({ action: z.enum(["start", "end"]), path: visPath, ...caller }).strict();

const inputSchema = z.object({
  path: visPath.describe("An .html, .htm, .svg, .tsx or .jsx file in this project, relative to the thread cwd."),
}).strict();

function parsePath(args: readonly string[]) {
  const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths([...args], { values: [] }), { trailing: true });
  if (flags.trailing.length !== 1) throw new WorkbenchCommandArgumentError("missingArgument", "<path>", "Name exactly one vis file.");
  return { path: flags.trailing[0]! };
}

const start = defineWorkbenchAgentCommand({
  words: ["vis", "start"],
  usage: "wb vis start <path>",
  description: "Show an .html, .svg, .tsx or .jsx file live to the user until you end it; snapshots it now.",
  effects: { readOnly: false },
  helpGroups: ["vis"],
  mcpCodeModeEligible: true,
  inputSchema,
  parseCliArgs: parsePath,
  buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action: "start", ...input, ...managedWorkbenchAgentCommandBody(context) }),
});

const end = defineWorkbenchAgentCommand({
  words: ["vis", "end"],
  usage: "wb vis end <path>",
  description: "End a live vis session and snapshot its final content.",
  effects: { readOnly: false },
  helpGroups: ["vis"],
  mcpCodeModeEligible: true,
  inputSchema,
  parseCliArgs: parsePath,
  buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action: "end", ...input, ...managedWorkbenchAgentCommandBody(context) }),
});

export const WORKBENCH_VIS_COMMANDS = [start, end] as const;
