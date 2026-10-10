/*
 * Exports:
 * - WorkbenchVisRequestSchema: validate one managed caller's vis session start, end or answer read.
 * - WORKBENCH_VIS_COMMANDS: `wb vis start`, `wb vis end` and `wb vis read`, shared by CLI and MCP.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const visPath = z.string().trim().min(1).max(1_000);
const caller = { cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1) };
const visProject = z.string().trim().min(1).max(1_000);
export const WorkbenchVisRequestSchema = z.object({
  action: z.enum(["start", "end", "read"]), path: visPath, project: visProject.optional(), ...caller,
}).strict();

const pathField = visPath.describe("An .html, .htm, .svg, .tsx or .jsx file in this project, relative to the thread cwd.");
const inputSchema = z.object({ path: pathField }).strict();
const startInputSchema = z.object({
  path: pathField,
  project: visProject.optional().describe(
    "Build context: \".\" (default) this project's .wb.json, a folder relative to the cwd with its own .wb.json, or \"default\" for Workbench's kit (import from \"workbench/vis\").",
  ),
}).strict();

function parsePath(args: readonly string[]) {
  const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths([...args], { values: [] }), { trailing: true });
  if (flags.trailing.length !== 1) throw new WorkbenchCommandArgumentError("missingArgument", "<path>", "Name exactly one vis file.");
  return { path: flags.trailing[0]! };
}

function parseStart(args: readonly string[]) {
  const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths([...args], { values: ["--project"] }), { trailing: true, values: ["--project"] });
  if (flags.trailing.length !== 1) throw new WorkbenchCommandArgumentError("missingArgument", "<path>", "Name exactly one vis file.");
  const project = flags.optional("--project");
  return { path: flags.trailing[0]!, ...(project ? { project } : {}) };
}

const start = defineWorkbenchAgentCommand({
  words: ["vis", "start"],
  usage: "wb vis start [--project <.|folder|default>] <path>",
  description: "Show an .html, .svg, .tsx or .jsx file live to the user until you end it; snapshots it now. Load the /vis skill first.",
  effects: { readOnly: false },
  helpGroups: ["vis"],
  mcpCodeModeEligible: true,
  inputSchema: startInputSchema,
  parseCliArgs: parseStart,
  buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action: "start", ...input, ...managedWorkbenchAgentCommandBody(context) }),
});

const read = defineWorkbenchAgentCommand({
  words: ["vis", "read"],
  usage: "wb vis read <path>",
  description: "Read what the user sent from a vis (wb.send), newest last.",
  effects: { readOnly: true },
  helpGroups: ["vis"],
  mcpCodeModeEligible: true,
  inputSchema,
  parseCliArgs: parsePath,
  buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action: "read", ...input, ...managedWorkbenchAgentCommandBody(context) }),
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

export const WORKBENCH_VIS_COMMANDS = [start, end, read] as const;
