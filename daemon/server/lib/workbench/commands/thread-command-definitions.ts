/*
 * Exports:
 * - WORKBENCH_THREAD_COMMANDS: typed task actions plus thread refresh, recall, and Code Mode exposure definitions shared by CLI and MCP.
 */
import { z } from "zod";

import { WORKBENCH_THREAD_RECALL_KINDS } from "workbench-shared/types";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  getWorkbenchAgentCommand,
  managedWorkbenchAgentCommandBody,
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
      ? "Set task completed; active sidebar threads apply it when the turn ends."
      : "Set task blocked; active sidebar threads apply it when the turn ends.",
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

const compact = defineWorkbenchAgentCommand({
  description: "Hand off the active OpenCode turn into a fresh native context.",
  audience: { harnesses: ["opencode"] },
  helpGroups: ["thread"],
  hideMcpTranscript: true,
  words: ["thread", "compact"],
  usage: "wb thread compact --summary <text>",
  inputSchema: z.object({
    summary: requiredText.describe("Complete post-context-compaction handoff for the replacement context."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--summary"] });
    return { summary: flags.required("--summary") };
  },
  buildRequest({ summary }, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-compact", {
      callerThreadId: requireCallerThreadId(callerThreadId), cwd, summary,
    });
  },
});

const recallKinds = z.array(z.enum(WORKBENCH_THREAD_RECALL_KINDS)).optional();

const recallSearch = defineWorkbenchAgentCommand({
  aliases: [["thread", "context", "search"]],
  description: "Search visible narrative history: words in any order, \"quoted phrases\", -exclusions. Hits rank by terms matched and print their --around command.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall", "search"],
  usage: "wb thread recall search [--thread <id>] --query <words> [--kind <kind>...] [--limit <count>] [--cursor <cursor>]",
  inputSchema: z.object({
    cursor: requiredText.optional(),
    kinds: recallKinds,
    limit: z.number().int().min(1).max(50).optional(),
    query: requiredText,
    threadId: requiredText.optional(),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--kind", "--query"], values: ["--thread", "--limit", "--cursor"], leadingDashValues: ["--query"] });
    const limit = flags.optionalNonNegativeInteger("--limit");
    const query = flags.repeated("--query").join(" ");
    if (!query) throw new Error("--query is required.");
    return {
      cursor: flags.optional("--cursor") ?? undefined,
      kinds: recallKinds.parse(flags.repeated("--kind")),
      limit: limit ?? undefined,
      query,
      threadId: flags.optional("--thread") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId }) {
    return postWorkbenchAgentCommand(`/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`, {
      action: "search", query: input.query,
      ...(input.kinds?.length ? { kinds: input.kinds } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  },
});

const recall = defineWorkbenchAgentCommand({
  aliases: [["thread", "context"]],
  description: "Read filtered history newest-first, or walk --before/--after/--around a ref.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall"],
  usage: "wb thread recall [--thread <id>] [--kind <kind>...] [--before <ref> | --after <ref> | --around <ref>]",
  inputSchema: z.object({
    after: requiredText.optional(),
    around: requiredText.optional(),
    before: requiredText.optional(),
    kinds: recallKinds,
    threadId: requiredText.optional(),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--kind"], values: ["--thread", "--before", "--after", "--around"] });
    return {
      after: flags.optional("--after") ?? undefined,
      around: flags.optional("--around") ?? undefined,
      before: flags.optional("--before") ?? undefined,
      kinds: recallKinds.parse(flags.repeated("--kind")),
      threadId: flags.optional("--thread") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId }) {
    return getWorkbenchAgentCommand(queryWorkbenchAgentCommandPath(
      `/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`,
      { after: input.after ?? null, around: input.around ?? null, before: input.before ?? null, kind: input.kinds ?? [] },
    ));
  },
});

export const WORKBENCH_THREAD_COMMANDS = [taskGet, taskSet, taskCompleted, taskBlocked, refresh, compact, recallSearch, recall] as const;
