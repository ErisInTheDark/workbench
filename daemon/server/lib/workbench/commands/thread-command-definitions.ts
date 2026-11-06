/*
 * Exports:
 * - WORKBENCH_THREAD_COMMANDS: thread refresh, compaction, recall and summary definitions shared by CLI and MCP.
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

/** Recall query parameters naming the calling thread; the daemon strips them before reading history. */
function recallCaller(callerThreadId: string | null, cwd: string) {
  return { caller: callerThreadId, cwd: callerThreadId ? cwd : null };
}

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
  buildRequest(input, { callerThreadId, cwd }) {
    // The caller travels beside the target so a thread on another daemon can be reached through a network grant.
    return postWorkbenchAgentCommand(queryWorkbenchAgentCommandPath(
      `/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`, recallCaller(callerThreadId, cwd),
    ), {
      action: "search", query: input.query,
      ...(input.kinds?.length ? { kinds: input.kinds } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  },
});

const recall = defineWorkbenchAgentCommand({
  aliases: [["thread", "context"]],
  description: "Read filtered history newest-first, walk --before/--after/--around a ref, or read one --turn, recovering it if retention expired it.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread", "thread-recall"],
  mcpCodeModeEligible: true,
  words: ["thread", "recall"],
  usage: "wb thread recall [--thread <id>] [--turn <id>] [--kind <kind>...] [--before <ref> | --after <ref> | --around <ref>]",
  inputSchema: z.object({
    after: requiredText.optional(),
    around: requiredText.optional(),
    before: requiredText.optional(),
    kinds: recallKinds,
    threadId: requiredText.optional(),
    turn: requiredText.optional(),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--kind"], values: ["--thread", "--turn", "--before", "--after", "--around"] });
    return {
      after: flags.optional("--after") ?? undefined,
      around: flags.optional("--around") ?? undefined,
      before: flags.optional("--before") ?? undefined,
      kinds: recallKinds.parse(flags.repeated("--kind")),
      threadId: flags.optional("--thread") ?? undefined,
      turn: flags.optional("--turn") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return getWorkbenchAgentCommand(queryWorkbenchAgentCommandPath(
      `/api/thread-context/${encodeURIComponent(targetThreadId(input.threadId, callerThreadId))}`,
      {
        after: input.after ?? null, around: input.around ?? null, before: input.before ?? null, kind: input.kinds ?? [], turn: input.turn ?? null,
        ...recallCaller(callerThreadId, cwd),
      },
    ));
  },
});

const summary = defineWorkbenchAgentCommand({
  description: "Read sidebar facts (title, status, project, host) of threads on this or any reachable daemon; needs no network approval.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread"],
  mcpCodeModeEligible: true,
  words: ["thread", "summary"],
  usage: "wb thread summary --thread <id>...",
  inputSchema: z.object({ threadIds: z.array(requiredText).min(1).max(64) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--thread"] });
    return { threadIds: flags.repeated("--thread") };
  },
  buildRequest({ threadIds }, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-summary", { callerThreadId: requireCallerThreadId(callerThreadId), cwd, threadIds });
  },
});

export const WORKBENCH_THREAD_COMMANDS = [refresh, compact, recallSearch, recall, summary] as const;
