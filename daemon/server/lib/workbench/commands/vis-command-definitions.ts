/*
 * Exports:
 * - WorkbenchVisRequestSchema: validate one managed caller's vis session start, end, answer read or browser check.
 * - WORKBENCH_VIS_COMMANDS: `wb vis start|end|read|snapshot|screenshot`, CLI-only: most threads never use vis, so its
 *   tools stay out of every thread's MCP list and the /vis skill teaches them when needed.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const visPath = z.string().trim().min(1).max(1_000);
const caller = { cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1) };
const visProject = z.string().trim().min(1).max(1_000);
type VisAction = "start" | "end" | "read" | "snapshot" | "screenshot";
export const WorkbenchVisRequestSchema = z.object({
  action: z.enum(["start", "end", "read", "snapshot", "screenshot"]), path: visPath, project: visProject.optional(), ...caller,
}).strict();

const inputSchema = z.object({ path: visPath }).strict();
const startInputSchema = z.object({ path: visPath, project: visProject.optional() }).strict();

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

function visCommand(action: Exclude<VisAction, "start">, description: string, readOnly: boolean) {
  return defineWorkbenchAgentCommand({
    words: ["vis", action],
    usage: `wb vis ${action} <path>`,
    description,
    effects: { readOnly },
    helpGroups: ["vis"],
    hideFromMcp: true,
    inputSchema,
    parseCliArgs: parsePath,
    buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action, ...input, ...managedWorkbenchAgentCommandBody(context) }),
  });
}

const start = defineWorkbenchAgentCommand({
  words: ["vis", "start"],
  usage: "wb vis start [--project <.|folder|kit>] <path>",
  description: "Show an .html, .svg, .tsx or .jsx file live to the user until you end it; snapshots it now. Load the /vis skill first.",
  effects: { readOnly: false },
  helpGroups: ["vis"],
  hideFromMcp: true,
  inputSchema: startInputSchema,
  parseCliArgs: parseStart,
  buildRequest: (input, context) => postWorkbenchAgentCommand("/internal/vis", { action: "start", ...input, ...managedWorkbenchAgentCommandBody(context) }),
});

export const WORKBENCH_VIS_COMMANDS = [
  start,
  visCommand("end", "End a live vis session and snapshot its final content.", false),
  visCommand("read", "Read what the user sent from a vis (wb.send), newest last.", true),
  visCommand("snapshot", "Accessibility snapshot of a live vis's current render, from its headless browser.", true),
  visCommand("screenshot", "Full-page screenshot of a live vis's current render, from its headless browser; the image is sent to you.", true),
] as const;
