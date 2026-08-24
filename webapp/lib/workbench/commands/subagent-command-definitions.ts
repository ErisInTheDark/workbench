/*
 * Exports:
 * - WORKBENCH_SUBAGENT_COMMANDS: typed subagent command definitions shared by CLI and MCP. Keywords: workbench, subagent, commands, registry.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
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
    mcpRuntimeDrainPolicy: action === "wait" ? "abort-immediately" : undefined,
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

const message = defineWorkbenchAgentCommand({
  description: "Message a direct child or parent, steering an active turn or starting an idle one.",
  helpGroups: ["subagent"],
  words: ["subagent", "message"],
  usage: "wb subagent message (--id <id> | --name <name> | --parent) --message <message>",
  inputSchema: z.object({
    message: requiredText,
    name: requiredText.optional(),
    parent: z.boolean().optional(),
    threadId: requiredText.optional(),
  }).strict().superRefine(({ name, parent, threadId }, context) => {
    if ([Boolean(name), Boolean(parent), Boolean(threadId)].filter(Boolean).length !== 1) {
      context.addIssue({ code: "custom", message: "Exactly one of name, parent, or threadId is required." });
    }
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--parent"], values: ["--id", "--name", "--message"] });
    return {
      message: flags.required("--message"),
      name: flags.optional("--name") ?? undefined,
      parent: flags.has("--parent") || undefined,
      threadId: flags.optional("--id") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "message", callerThreadId: requireCallerThreadId(callerThreadId), cwd, message: input.message,
      ...(input.name ? { name: input.name } : {}),
      ...(input.parent ? { parent: true } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    });
  },
});

export const WORKBENCH_SUBAGENT_COMMANDS = [list, profiles, create, wait, stop, settle, message] as const;
