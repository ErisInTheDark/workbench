/*
 * Exports:
 * - WORKBENCH_THREAD_COMMANDS: typed thread title, status, resume, recall, and Code Mode exposure definitions shared by CLI and MCP. Keywords: workbench, thread, commands, recall, Code Mode.
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
const threadStatus = z.enum(["completed", "blocked"]);

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function targetThreadId(explicitThreadId: string | undefined, callerThreadId: string | null) {
  return explicitThreadId ?? requireCallerThreadId(callerThreadId);
}

const titleGet = defineWorkbenchAgentCommand({
  description: "Get the current title for a managed thread.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["thread"],
  mcpCodeModeEligible: true,
  words: ["thread", "title", "get"],
  usage: "wb thread title get",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
  buildRequest(_input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-title", { action: "get", callerThreadId: requireCallerThreadId(callerThreadId), cwd }, "thread-title-get");
  },
});

const title = defineWorkbenchAgentCommand({
  description: "Set a concise title for a managed thread.",
  helpGroups: ["thread"],
  mcpCodeModeEligible: true,
  words: ["thread", "title"],
  usage: "wb thread title --title <text>",
  inputSchema: z.object({ title: requiredText }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--title"] });
    return { title: flags.required("--title") };
  },
  buildRequest({ title: nextTitle }, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-title", { action: "set", callerThreadId: requireCallerThreadId(callerThreadId), cwd, title: nextTitle }, "thread-title");
  },
});

const status = defineWorkbenchAgentCommand({
  description: "Set the exact current turn status for this managed thread.",
  helpGroups: ["thread"],
  words: ["thread", "status"],
  usage: "wb thread status --status <completed|blocked>",
  inputSchema: z.object({ status: threadStatus }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--status"] });
    return { status: threadStatus.parse(flags.required("--status")) };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-status", { callerThreadId: requireCallerThreadId(callerThreadId), cwd, status: input.status }, "thread-status");
  },
});

const resume = defineWorkbenchAgentCommand({
  description: "Interrupt this managed turn and start its lifecycle-owned replacement turn.",
  helpGroups: ["thread"],
  words: ["thread", "resume"],
  usage: "wb thread resume",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) { new WorkbenchAgentCommandFlags(args, {}); return {}; },
  buildRequest(_input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/thread-resume", { callerThreadId: requireCallerThreadId(callerThreadId), cwd }, "thread-resume");
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

export const WORKBENCH_THREAD_COMMANDS = [titleGet, title, status, resume, recallSearch, recallExpand, recall] as const;
