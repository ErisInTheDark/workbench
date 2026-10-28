/*
 * Exports:
 * - WORKBENCH_PROOF_OF_WORK_COMMANDS: expose checklist proofs through MCP and CLI.
 */
import { ProofOfWorkSchema } from "workbench-shared/workbench/thread/proof-of-work";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const proofOfWork = defineWorkbenchAgentCommand({
  words: ["proof", "of", "work"],
  usage: "wb proof of work --proofs-json <json-object>",
  description: "File every reasoning checklist item after completing private reasoning; each answer is not applicable or a one-to-two-sentence decision or note.",
  effects: { readOnly: true },
  helpGroups: [],
  inputSchema: ProofOfWorkSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--proofs-json"] });
    return ProofOfWorkSchema.parse({ proofs: JSON.parse(flags.required("--proofs-json")) });
  },
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/proof-of-work", input, "json");
  },
});

export const WORKBENCH_PROOF_OF_WORK_COMMANDS = [proofOfWork] as const;
