/*
 * Exports:
 * - WorkbenchProofOfWorkRequestSchema: validate one managed caller's checklist submission.
 * - WORKBENCH_PROOF_OF_WORK_COMMANDS: expose checklist proofs through MCP and CLI.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { ProofOfWorkSchema } from "workbench-shared/workbench/thread/proof-of-work";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

export const WorkbenchProofOfWorkRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  proof: ProofOfWorkSchema,
  threadId: z.string().trim().min(1),
}).strict();

const proofOfWork = defineWorkbenchAgentCommand({
  words: ["proof", "of", "work"],
  usage: "wb proof of work [--proofs-json <json-object>] [--not-applicable <id>]... [--defer <id>]...",
  description: "File reasoning checklist items after private reasoning: answered ids with one-to-two-sentence decisions or notes, not-applicable ids, and ids still in progress to file later.",
  effects: { readOnly: true },
  helpGroups: [],
  inputSchema: ProofOfWorkSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--proofs-json"], repeatable: ["--not-applicable", "--defer"] });
    const proofs = flags.optional("--proofs-json");
    const notApplicable = flags.repeated("--not-applicable");
    const defer = flags.repeated("--defer");
    return ProofOfWorkSchema.parse({
      ...(proofs === null ? {} : { proofs: JSON.parse(proofs) }),
      ...(notApplicable.length ? { notApplicable } : {}),
      ...(defer.length ? { defer } : {}),
    });
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/proof-of-work", { proof: input, ...managedWorkbenchAgentCommandBody(context) });
  },
});

export const WORKBENCH_PROOF_OF_WORK_COMMANDS = [proofOfWork] as const;
