/*
 * Exports:
 * - WORKBENCH_THREAD_COMMANDS: typed task actions plus thread refresh, recall, and Code Mode exposure definitions shared by CLI and MCP.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  getWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
  queryWorkbenchAgentCommandPath,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function targetThreadId(explicitThreadId: string | undefined, callerThreadId: string | null) {
  return explicitThreadId ?? requireCallerThreadId(callerThreadId);
}

const taskGet = defineWorkbenchAgentCommand({
  description: "Get the current title for this managed task.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["task"],
  mcpCodeModeEligible: true,
  words: ["task", "get"],
  usage: "wb task get",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
  buildRequest(_input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-title", { action: "get", callerThreadId: requireCallerThreadId(callerThreadId), cwd }, "thread-title-get");
  },
});

const taskSet = defineWorkbenchAgentCommand({
  description: "Set a concise title for this managed task only when the supplied current title matches.",
  helpGroups: ["task"],
  mcpCodeModeEligible: true,
  words: ["task", "set"],
  usage: "wb task set --title <text> [--current-title <text>]",
  inputSchema: z.object({
    currentTitle: z.string().min(1).optional().describe("Exact current task title. Omit only when no title is set."),
    title: requiredText,
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--current-title", "--title"] });
    return { currentTitle: flags.optional("--current-title") ?? undefined, title: flags.required("--title") };
  },
  buildRequest({ currentTitle, title: nextTitle }, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-title", {
      action: "set", callerThreadId: requireCallerThreadId(callerThreadId),
      ...(currentTitle !== undefined ? { currentTitle } : {}),
      cwd, title: nextTitle,
    }, "thread-title");
  },
});

function taskStatus(status: "blocked" | "completed") {
  return defineWorkbenchAgentCommand({
    description: status === "completed"
      ? "Mark this managed task completed."
      : "Mark this managed task blocked.",
    helpGroups: ["task"],
    words: ["task", status],
    usage: `wb task ${status}`,
    inputSchema: z.object({}).strict(),
    parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
    buildRequest(_input, { callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/thread-status", {
        callerThreadId: requireCallerThreadId(callerThreadId),
        cwd,
        status,
      }, "thread-status");
    },
  });
}

const taskCompleted = taskStatus("completed");
const taskBlocked = taskStatus("blocked");

const refresh = defineWorkbenchAgentCommand({
  description: "Refresh this managed thread by interrupting the current turn and starting its lifecycle-owned replacement.",
  helpGroups: ["thread"],
  words: ["thread", "refresh"],
  usage: "wb thread refresh",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
  buildRequest(_input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-resume", { callerThreadId: requireCallerThreadId(callerThreadId), cwd }, "thread-refresh");
  },
});

const recallSearch = defineWorkbenchAgentCommand({
  aliases: [["thread", "context", "search"]],
  description: "Search visible narrative history and return stable result references.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall", "search"],
  usage: "wb thread recall search [--thread <id>] --query <text> [--kind <kind>...] [--limit <count>] [--before <ref>]",
  inputSchema: z.object({
    before: requiredText.optional(),
    kinds: z.array(requiredText).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    query: requiredText,
    threadId: requiredText.optional(),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--kind"], values: ["--thread", "--query", "--limit", "--before"] });
    const limit = flags.optionalNonNegativeInteger("--limit");
    return {
      before: flags.optional("--before") ?? undefined,
      kinds: flags.repeated("--kind"),
      limit: limit ?? undefined,
      query: flags.required("--query"),
      threadId: flags.optional("--thread") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId }) {
    return postWorkbenchAgentCommand(`/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`, {
      action: "search", query: input.query,
      ...(input.kinds?.length ? { kinds: input.kinds } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.before ? { before: input.before } : {}),
    });
  },
});

const recallExpand = defineWorkbenchAgentCommand({
  aliases: [["thread", "context", "expand"]],
  description: "Read one referenced record through fixed-budget content pages.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall", "expand"],
  usage: "wb thread recall expand [--thread <id>] --ref <ref> [--cursor <cursor>]",
  inputSchema: z.object({ cursor: requiredText.optional(), ref: requiredText, threadId: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--thread", "--ref", "--cursor"] });
    return { cursor: flags.optional("--cursor") ?? undefined, ref: flags.required("--ref"), threadId: flags.optional("--thread") ?? undefined };
  },
  buildRequest(input, { callerThreadId }) {
    return postWorkbenchAgentCommand(`/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`, {
      action: "expand", ref: input.ref, ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  },
});

const recall = defineWorkbenchAgentCommand({
  aliases: [["thread", "context"]],
  description: "Read filtered history newest-first, or continue before an emitted cursor.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall"],
  usage: "wb thread recall [--thread <id>] [--kind <kind>...] [--before <cursor>]",
  inputSchema: z.object({ before: requiredText.optional(), kinds: z.array(requiredText).optional(), threadId: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--kind"], values: ["--thread", "--before"] });
    return { before: flags.optional("--before") ?? undefined, kinds: flags.repeated("--kind"), threadId: flags.optional("--thread") ?? undefined };
  },
  buildRequest(input, { callerThreadId }) {
    return getWorkbenchAgentCommand(queryWorkbenchAgentCommandPath(
      `/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`,
      { before: input.before ?? null, kind: input.kinds ?? [] },
    ));
  },
});

export const WORKBENCH_THREAD_COMMANDS = [taskGet, taskSet, taskCompleted, taskBlocked, refresh, recallSearch, recallExpand, recall] as const;
