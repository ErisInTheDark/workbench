/*
 * Exports:
 * - WorkbenchNetworkRequestSchema/WorkbenchNetworkRequest: the body of one `wb network request`.
 * - WORKBENCH_NETWORK_COMMANDS: `wb network request`, asking the user up front to let this thread reach remote threads, folders or feedback.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const text = z.string().trim().min(1).max(4096);
const targets = z.array(text).max(16).optional();

export const WorkbenchNetworkRequestSchema = z.object({
  threadId: text, cwd: text, harness: text, requestKey: text, reason: text,
  threads: z.array(text).max(16), folders: z.array(text).max(16), feedback: z.array(text).max(16),
}).strict();
export type WorkbenchNetworkRequest = z.infer<typeof WorkbenchNetworkRequestSchema>;

const request = defineWorkbenchAgentCommand({
  words: ["network", "request"],
  usage: "wb network request (--thread <id>... | --folder <host>[:<folder>]... | --feedback <host>[:<folder>]...) --reason <text>",
  description: "Ask the user, before you need it, to let this thread reach remote threads, project folders (for subagents) or another daemon's feedback, and wait for their answer.",
  effects: { readOnly: false },
  helpGroups: ["network"],
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  inputSchema: z.object({
    threadIds: targets.describe("Remote Workbench thread ids to message, wait on, recall or read transcripts of."),
    folders: targets.describe("`<host>[:<folder>]` folders to create subagents in; other projects' need `<folder>`."),
    feedback: targets.describe("`<host>` for a daemon's wb feedback, or `<host>:<folder>` for that folder's project feedback."),
    reason: text.describe("Why the task needs this access, shown to the user."),
  }).strict().refine(input => Boolean(input.threadIds?.length || input.folders?.length || input.feedback?.length), "Name at least one target."),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--thread", "--folder", "--feedback"], values: ["--reason"] });
    return {
      threadIds: flags.repeated("--thread"), folders: flags.repeated("--folder"), feedback: flags.repeated("--feedback"),
      reason: flags.required("--reason"),
    };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/api/network", {
      ...managedWorkbenchAgentCommandBody(context),
      // A stable key lets a reload restore the same pending prompt instead of asking twice.
      requestKey: `${WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX}${randomUUID()}`,
      reason: input.reason,
      threads: input.threadIds ?? [], folders: input.folders ?? [], feedback: input.feedback ?? [],
    });
  },
});

export const WORKBENCH_NETWORK_COMMANDS = [request] as const;
