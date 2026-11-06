/*
 * Exports:
 * - WorkbenchThreadStateRequestSchema: validate one managed caller's thread_state call.
 * - WORKBENCH_THREAD_STATE_COMMANDS: expose the thread_state tool through MCP and CLI.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { ThreadStateSchema } from "workbench-shared/workbench/thread/workflow-modes";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

export const WorkbenchThreadStateRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  state: ThreadStateSchema,
  threadId: z.string().trim().min(1),
}).strict();

const threadState = defineWorkbenchAgentCommand({
  words: ["thread", "state"],
  usage: "wb thread state [--proofs-json <json-object>] [--not-applicable <id>]... [--mode <name>] "
    + "[--title <text> [--current-title <text>]] [--status completed|blocked] [--process-document <path>]... [--clear-process-documents]",
  description: "Read this thread's state, or change it in one call: file Gotcha Checklist proofs (what each item found, "
    + "or not-applicable ids), enter a mode, retitle, set status, and set its process documents. "
    + "Proofs always file; a refused mode or status applies nothing else. Every result reports the full state.",
  helpGroups: ["thread"],
  inputSchema: ThreadStateSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      values: ["--proofs-json", "--mode", "--title", "--current-title", "--status"],
      repeatable: ["--not-applicable", "--process-document"],
      boolean: ["--clear-process-documents"],
    });
    const proofs = flags.optional("--proofs-json");
    const notApplicable = flags.repeated("--not-applicable");
    const processDocuments = flags.repeated("--process-document");
    return ThreadStateSchema.parse({
      ...(proofs === null ? {} : { proofs: JSON.parse(proofs) }),
      ...(notApplicable.length ? { notApplicable } : {}),
      ...(flags.optional("--mode") ? { mode: flags.optional("--mode") } : {}),
      ...(flags.optional("--title") ? { title: flags.optional("--title") } : {}),
      ...(flags.optional("--current-title") ? { currentTitle: flags.optional("--current-title") } : {}),
      ...(flags.optional("--status") ? { status: flags.optional("--status") } : {}),
      ...(processDocuments.length || flags.has("--clear-process-documents") ? { processDocuments } : {}),
    });
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/thread-state", { state: input, ...managedWorkbenchAgentCommandBody(context) });
  },
});

export const WORKBENCH_THREAD_STATE_COMMANDS = [threadState] as const;
