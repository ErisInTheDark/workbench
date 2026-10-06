/*
 * Exports:
 * - WORKBENCH_SUBAGENT_COMMANDS: typed subagent lifecycle, wait, and queue command definitions shared by CLI and MCP.
 */
import { z } from "zod";

import {
  WorkbenchSubagentDequeueInputSchema,
  WorkbenchSubagentQueueInputSchema,
} from "../subagent/subagent-queue-contract";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const targetsSchema = z.object({
  names: z.array(requiredText).optional(),
  threadIds: z.array(requiredText).optional(),
}).strict().superRefine(({ names = [], threadIds = [] }, context) => {
  if (!names.length && !threadIds.length) context.addIssue({ code: "custom", message: "At least one name or thread ID target is required." });
  if (new Set(threadIds).size !== threadIds.length) context.addIssue({ code: "custom", message: "Thread ID targets must be unique." });
  if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    context.addIssue({ code: "custom", message: "Name targets must be unique ignoring case." });
  }
});

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function parseTargets(args: string[]) {
  const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--id", "--name"] });
  return { names: flags.repeated("--name"), threadIds: flags.repeated("--id") };
}

function targetsBody(input: z.output<typeof targetsSchema>) {
  return {
    ...(input.names?.length ? { names: input.names } : {}),
    ...(input.threadIds?.length ? { threadIds: input.threadIds } : {}),
  };
}

const list = defineWorkbenchAgentCommand({
  description: "List unsettled direct children, or settled history.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["subagent"],
  words: ["subagent", "list"],
  usage: "wb subagent list [--settled [--cursor <cursor>] [--limit <1-20>]]",
  inputSchema: z.object({
    cursor: requiredText.optional(),
    limit: z.number().int().min(1).max(20).optional(),
    settled: z.boolean().default(false),
  }).strict().superRefine(({ cursor, limit, settled }, context) => {
    if (!settled && (cursor || limit !== undefined)) context.addIssue({ code: "custom", message: "cursor and limit require settled history." });
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--settled"], values: ["--cursor", "--limit"] });
    const limit = flags.optionalNonNegativeInteger("--limit");
    return {
      cursor: flags.optional("--cursor") ?? undefined,
      limit: limit ?? undefined,
      settled: flags.has("--settled"),
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "list",
      callerThreadId: requireCallerThreadId(callerThreadId),
      cwd,
      settled: input.settled,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }, "subagent-list");
  },
});

const profiles = defineWorkbenchAgentCommand({
  description: "List the subagent profiles available to this thread.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["subagent"],
  words: ["subagent", "profiles"],
  usage: "wb subagent profiles",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
  buildRequest(_input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "profiles", callerThreadId: requireCallerThreadId(callerThreadId), cwd,
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    }, "json");
  },
});

const create = defineWorkbenchAgentCommand({
  description: "Create and start a direct child, then print its thread ID.",
  helpGroups: ["subagent"],
  words: ["subagent", "create"],
  usage: "wb subagent create --profile <profile-id> --name <name> --title <title> --message <message>",
  inputSchema: z.object({ message: requiredText, name: requiredText, profileId: requiredText, title: requiredText }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--profile", "--name", "--title", "--message"] });
    return { message: flags.required("--message"), name: flags.required("--name"), profileId: flags.required("--profile"), title: flags.required("--title") };
  },
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "create", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...input,
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    }, "subagent-create");
  },
});

function targetCommand(action: "settle" | "stop" | "wait", description: string) {
  return defineWorkbenchAgentCommand({
    description,
    effects: action === "wait" ? { idempotent: true, readOnly: true } : action === "stop" ? { destructive: true } : {},
    helpGroups: ["subagent"],
    mcpCodeModeEligible: action === "wait" || undefined,
    mcpRuntimeDrainPolicy: action === "wait" ? "preserve-across-reload" : undefined,
    mcpSteerInterruptible: action === "wait" || undefined,
    words: ["subagent", action],
    usage: `wb subagent ${action} (--id <id> | --name <name>) [...]`,
    inputSchema: targetsSchema,
    parseCliArgs: parseTargets,
    buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
      return postWorkbenchAgentCommand("/api/subagents", {
        action, callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...targetsBody(input),
        ...(action !== "settle" && workbenchOrigin ? { workbenchOrigin } : {}),
      }, action === "settle" ? "subagent-settle" : "native");
    },
  });
}

const wait = targetCommand("wait", "Wait until any selected child needs attention or reaches a terminal state.");
const stop = targetCommand("stop", "Stop one or more direct child threads.");
const settle = targetCommand("settle", "Settle one or more completed or stopped direct children.");

/** Split the leading `<queue>` operand from the flag grammar. */
function splitQueueOperand(args: string[]) {
  const [queue, ...rest] = args;
  if (!queue || queue.startsWith("-")) throw new WorkbenchCommandArgumentError("missingArgument", "<queue>", "A queue name operand is required first.");
  return { queue, rest };
}

const queue = defineWorkbenchAgentCommand({
  description: "Parent-declared turn queue for contended work. With description: join (or resume/move when queued) and long-wait until you hold it; hold lasts until subagent_dequeue. Without: show queue info (a parent call declares the queue). after/before place relative to a member or \"parent\"; parent-only name moves that member. Workbench Long Wait; steers interrupt it but keep your place.",
  helpGroups: ["subagent"],
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  mcpSteerInterruptible: true,
  words: ["subagent", "queue"],
  usage: "wb subagent queue <queue> [--description <work>] [--after <member> | --before <member>] [--name <member>]",
  inputSchema: WorkbenchSubagentQueueInputSchema,
  parseCliArgs(args) {
    const { queue, rest } = splitQueueOperand(args);
    const flags = new WorkbenchAgentCommandFlags(rest, { values: ["--description", "--after", "--before", "--name"] });
    return {
      queue,
      after: flags.optional("--after") ?? undefined,
      before: flags.optional("--before") ?? undefined,
      description: flags.optional("--description") ?? undefined,
      name: flags.optional("--name") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagent-queue", {
      action: "queue", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...input,
    });
  },
});

const dequeue = defineWorkbenchAgentCommand({
  description: "Leave a subagent queue, handing your hold to the next member. Parent-only name removes that member instead.",
  helpGroups: ["subagent"],
  words: ["subagent", "dequeue"],
  usage: "wb subagent dequeue <queue> [--name <member>]",
  inputSchema: WorkbenchSubagentDequeueInputSchema,
  parseCliArgs(args) {
    const { queue, rest } = splitQueueOperand(args);
    const flags = new WorkbenchAgentCommandFlags(rest, { values: ["--name"] });
    return { queue, name: flags.optional("--name") ?? undefined };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagent-queue", {
      action: "dequeue", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...input,
    });
  },
});

export const WORKBENCH_SUBAGENT_COMMANDS = [list, profiles, create, wait, stop, settle, queue, dequeue] as const;
