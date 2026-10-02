/*
 * Exports:
 * - WorkbenchStoreCommandRequestSchema/WorkbenchStoreCommandRequest: validated human store get/set request for one cwd.
 * - WORKBENCH_STORE_COMMANDS: human-only `wb store get|set`, absent from help and MCP and rejected for managed callers.
 */
import { z } from "zod";
import { ProjectStoreKeySchema } from "workbench-shared/workbench/project/project-store";

import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

export const WorkbenchStoreCommandRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), cwd: z.string().trim().min(1), key: ProjectStoreKeySchema }).strict(),
  z.object({ action: z.literal("set"), cwd: z.string().trim().min(1), key: ProjectStoreKeySchema, value: z.string() }).strict(),
]);
export type WorkbenchStoreCommandRequest = z.output<typeof WorkbenchStoreCommandRequestSchema>;

function requireHuman(callerThreadId: string | null) {
  if (callerThreadId) throw new Error("wb store is not available to Workbench-managed agents.");
}

function operands(args: readonly string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

const get = defineWorkbenchAgentCommand({
  description: "Print one project store value.",
  effects: { readOnly: true },
  helpGroups: [],
  hideFromMcp: true,
  hideFromRootHelp: true,
  words: ["store", "get"],
  usage: "wb store get <key>",
  inputSchema: z.object({ key: ProjectStoreKeySchema }).strict(),
  parseCliArgs(args) {
    const [key, ...extra] = operands(args);
    if (key === undefined || extra.length) throw new Error("wb store get requires exactly one key.");
    return { key };
  },
  buildRequest({ key }, { callerThreadId, cwd }) {
    requireHuman(callerThreadId);
    return postWorkbenchAgentCommand("/internal/store", { action: "get", cwd, key });
  },
});

const set = defineWorkbenchAgentCommand({
  description: "Encrypt and save one project store value.",
  effects: { idempotent: true },
  helpGroups: [],
  hideFromMcp: true,
  hideFromRootHelp: true,
  words: ["store", "set"],
  usage: "wb store set <key> [--] <value>",
  inputSchema: z.object({ key: ProjectStoreKeySchema, value: z.string() }).strict(),
  parseCliArgs(args) {
    const [key, ...rest] = args;
    const values = operands(rest);
    if (key === undefined || values.length !== 1) throw new Error("wb store set requires a key and one value.");
    return { key, value: values[0]! };
  },
  buildRequest({ key, value }, { callerThreadId, cwd }) {
    requireHuman(callerThreadId);
    return postWorkbenchAgentCommand("/internal/store", { action: "set", cwd, key, value });
  },
});

export const WORKBENCH_STORE_COMMANDS = [get, set] as const;
