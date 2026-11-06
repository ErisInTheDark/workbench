/*
 * Exports:
 * - WorkbenchSkillExecutionRequestSchema: validate managed skill-load and skill-locate requests.
 * - WORKBENCH_SKILL_COMMANDS: expose precedence-selected skill loading and source location to wb and MCP.
 * - workbenchSkillName: validate a skill directory name.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

export const workbenchSkillName = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .describe("Skill directory name resolved by Workbench precedence.");

const locate = z.boolean().optional()
  .describe("Instead of loading, list every copy's source layer and path in precedence order, marking the active one.");

export const WorkbenchSkillExecutionRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  locate,
  name: workbenchSkillName,
  threadId: z.string().trim().min(1),
}).strict();

const skill = defineWorkbenchAgentCommand({
  description: "Load one Workbench skill by name using project, user, and builtin precedence. Returns only rendered skill text.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["skill"],
  mcpCodeModeEligible: true,
  mcpFullOutput: true,
  mcpWorkdir: true,
  words: ["skill"],
  usage: "wb skill [--locate] <name>",
  inputSchema: z.object({ locate, name: workbenchSkillName }).strict(),
  parseCliArgs(args) {
    const names = args.filter(arg => arg !== "--locate");
    if (names.length !== 1) throw new Error("wb skill requires one skill name.");
    return { name: names[0], ...names.length < args.length ? { locate: true } : {} };
  },
  buildRequest({ locate, name }, context) {
    return postWorkbenchAgentCommand("/api/skill", {
      ...managedWorkbenchAgentCommandBody(context),
      ...locate ? { locate } : {},
      name,
    });
  },
});

export const WORKBENCH_SKILL_COMMANDS = [skill] as const;
