/*
 * Exports:
 * - WORKBENCH_MESSAGE_COMMANDS: canonical global message command plus reload-safe legacy compatibility.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const messageInputSchema = z.object({
  message: requiredText,
  name: requiredText.optional(),
  parent: z.boolean().optional(),
  threadId: requiredText.optional(),
}).strict().superRefine(({ name, parent, threadId }, context) => {
  if ([Boolean(name), Boolean(parent), Boolean(threadId)].filter(Boolean).length !== 1) {
    context.addIssue({ code: "custom", message: "Exactly one of name, parent, or threadId is required." });
  }
});

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function messageCommand(legacy: boolean) {
  return defineWorkbenchAgentCommand({
    description: legacy
      ? "Legacy compatibility for messaging a direct child or parent."
      : "Message one same-project thread, steering an active turn or starting an idle one.",
    helpGroups: legacy ? [] : ["message"],
    hideFromRootHelp: legacy || undefined,
    words: legacy ? ["subagent", "message"] : ["message"],
    usage: legacy
      ? "wb subagent message (--id <id> | --name <name> | --parent) --message <message>"
      : "wb message (--thread <id> | --name <name> | --parent) --message <message>",
    inputSchema: messageInputSchema,
    parseCliArgs(args) {
      const threadFlag = legacy ? "--id" : "--thread";
      const flags = new WorkbenchAgentCommandFlags(args, {
        boolean: ["--parent"],
        values: [threadFlag, "--name", "--message"],
      });
      return {
        message: flags.required("--message"),
        name: flags.optional("--name") ?? undefined,
        parent: flags.has("--parent") || undefined,
        threadId: flags.optional(threadFlag) ?? undefined,
      };
    },
    buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
      return postWorkbenchAgentCommand(legacy ? "/api/subagents" : "/api/message", {
        ...(legacy ? { action: "message" } : {}),
        callerThreadId: requireCallerThreadId(callerThreadId),
        cwd,
        message: input.message,
        ...(input.name ? { name: input.name } : {}),
        ...(input.parent ? { parent: true } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  });
}

export const WORKBENCH_MESSAGE_COMMANDS = [messageCommand(false), messageCommand(true)] as const;
