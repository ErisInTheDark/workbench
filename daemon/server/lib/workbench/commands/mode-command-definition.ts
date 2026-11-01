/*
 * Exports:
 * - WorkbenchModeSwitchRequestSchema: validate one managed caller's mode switch.
 * - WORKBENCH_MODE_COMMANDS: expose workflow mode switches through MCP and CLI.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { ModeSwitchSchema } from "workbench-shared/workbench/thread/workflow-modes";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

export const WorkbenchModeSwitchRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  mode: ModeSwitchSchema.shape.mode,
  threadId: z.string().trim().min(1),
}).strict();

const modeSet = defineWorkbenchAgentCommand({
  words: ["mode", "set"],
  usage: "wb mode set --mode <name>",
  description: "Enter a workflow or skill mode, shown to the user as a divider. Rejects a workflow-gated mode until the checklists it requires are filed.",
  helpGroups: [],
  inputSchema: ModeSwitchSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--mode"] });
    return ModeSwitchSchema.parse({ mode: flags.required("--mode") });
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/mode-set", { mode: input.mode, ...managedWorkbenchAgentCommandBody(context) });
  },
});

export const WORKBENCH_MODE_COMMANDS = [modeSet] as const;
