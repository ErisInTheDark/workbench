/*
 * Exports:
 * - WorkbenchFeedbackSubmitRequestSchema: validate one managed caller's feedback submission.
 * - WORKBENCH_FEEDBACK_COMMANDS: `wb feedback` and the `feedback` MCP tool for reporting avoidable friction.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import {
  WorkbenchFeedbackCategorySchema,
  WorkbenchFeedbackChannelSchema,
  WorkbenchFeedbackReportSchema,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const inputSchema = z.object({
  channel: WorkbenchFeedbackChannelSchema
    .describe("wb: Workbench tools or Workbench instructions. project: project tooling, scripts, or project instructions."),
  category: WorkbenchFeedbackCategorySchema
    .describe("bug: broken behaviour. waste: avoidable tokens, steps, or output. confusion: unclear or conflicting guidance. opportunity: concrete improvement."),
  report: WorkbenchFeedbackReportSchema
    .describe("What you did, why, and what you suggest. Plain and specific."),
}).strict();

export const WorkbenchFeedbackSubmitRequestSchema = inputSchema.extend({
  cwd: z.string().trim().min(1),
  harness: ProviderKeySchema,
  threadId: z.string().trim().min(1),
}).strict();

const feedback = defineWorkbenchAgentCommand({
  words: ["feedback"],
  usage: "wb feedback --channel <wb|project> --category <bug|waste|confusion|opportunity> -- <report>",
  description: "Report avoidable friction once per issue: something broken, wasteful, confusing, or improvable in Workbench or project tooling or instructions.",
  effects: { readOnly: false },
  helpGroups: [],
  mcpCodeModeEligible: true,
  inputSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { trailing: true, values: ["--channel", "--category"] });
    return inputSchema.parse({ channel: flags.required("--channel"), category: flags.required("--category"), report: flags.trailing.join(" ") });
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/feedback", { ...managedWorkbenchAgentCommandBody(context), ...input });
  },
});

export const WORKBENCH_FEEDBACK_COMMANDS = [feedback] as const;
