/*
 * Exports:
 * - WorkbenchSkillExecutionRequestSchema: validate managed skill-load requests.
 * - WORKBENCH_SKILL_COMMANDS: expose precedence-selected skill loading to wb and MCP.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const skillName = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .describe("Skill directory name resolved by Workbench precedence.");

export const WorkbenchSkillExecutionRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  name: skillName,
  threadId: z.string().trim().min(1),
}).strict();

const skill = defineWorkbenchAgentCommand({
  description: "Load one Workbench skill by name using project, user, and builtin precedence. Returns only rendered skill text.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["skill"],
  mcpCodeModeEligible: true,
  words: ["skill"],
  usage: "wb skill <name>",
  inputSchema: z.object({ name: skillName }).strict(),
  parseCliArgs(args) {
    if (args.length !== 1) throw new Error("wb skill requires one skill name.");
    return { name: args[0] };
  },
  buildRequest({ name }, context) {
    return postWorkbenchAgentCommand("/api/skill", {
      ...managedWorkbenchAgentCommandBody(context),
      name,
    });
  },
});

export const WORKBENCH_SKILL_COMMANDS = [skill] as const;
