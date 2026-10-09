/*
 * Exports:
 * - WorkbenchClaimStatsExecutionRequestSchema: validate cwd-owned claim analysis.
 * - WorkbenchFeedbackStatsExecutionRequestSchema: validate cwd-owned feedback reads; only wb-channel reads may span projects.
 * - WorkbenchToolStatsExecutionRequestSchema: validate cwd-owned tool value reads; --all-projects spans every project.
 * - WORKBENCH_STATS_COMMANDS: CLI-only claim ranking, file-thread reads, agent feedback reads, and tool value ranking.
 */
import { z } from "zod";
import { WorkbenchClaimStatsRangeSchema } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import { WorkbenchStatsRangeSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  WORKBENCH_FEEDBACK_SORTS,
  WorkbenchFeedbackCategorySchema,
  WorkbenchFeedbackChannelSchema,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const page = z.number().int().min(1).max(1_000_000).default(1);
const range = WorkbenchClaimStatsRangeSchema.default("7d");
const cwd = z.string().trim().min(1);

const claimsInputSchema = z.object({
  file: z.string().trim().min(1).max(2_000).nullable().default(null),
  range,
  page,
}).strict();
export const WorkbenchClaimStatsExecutionRequestSchema = claimsInputSchema.extend({ cwd }).strict();

const feedbackFields = z.object({
  allProjects: z.boolean().default(false),
  category: WorkbenchFeedbackCategorySchema.nullable().default(null),
  channel: WorkbenchFeedbackChannelSchema.nullable().default(null),
  page,
  range,
  sort: z.enum(WORKBENCH_FEEDBACK_SORTS).default("importance"),
}).strict();
const wbOnlyAcrossProjects = <T extends { allProjects: boolean; channel: string | null }>(value: T) => !value.allProjects || value.channel === "wb";
const ALL_PROJECTS_MESSAGE = "--all-projects requires --channel wb; project feedback stays with its project.";
const feedbackInputSchema = feedbackFields.refine(wbOnlyAcrossProjects, ALL_PROJECTS_MESSAGE);
export const WorkbenchFeedbackStatsExecutionRequestSchema = feedbackFields.extend({ cwd }).strict()
  .refine(wbOnlyAcrossProjects, ALL_PROJECTS_MESSAGE);

const toolsInputSchema = z.object({
  allProjects: z.boolean().default(false),
  descending: z.boolean().default(false),
  range: WorkbenchStatsRangeSchema.default("7d"),
  sort: z.enum(["value", "calls", "cost", "tool"]).default("value"),
}).strict();
export const WorkbenchToolStatsExecutionRequestSchema = toolsInputSchema.extend({ cwd }).strict();

const TOOLS_USAGE = "wb stats tools [--range <7d|14d|30d|90d|365d>] [--sort <value|calls|cost|tool>] [--descending]";
const FEEDBACK_USAGE = "wb stats feedback [--channel <wb|project>] [--category <bug|waste|confusion|opportunity>] [--sort <importance|newest>] [--range <7d|14d|30d|90d|365d|all>] [--page <n>]";

export const WORKBENCH_STATS_COMMANDS = [defineWorkbenchAgentCommand({
  words: ["stats", "claims"],
  usage: "wb stats claims [--file <root:path>] [--range <7d|14d|30d|90d|365d|all>] [--page <n>]",
  description: "Rank files by distinct claiming threads, or list one file's claiming thread titles and ids.",
  effects: { readOnly: true, idempotent: true },
  hideFromMcp: true,
  helpGroups: ["stats"],
  inputSchema: claimsInputSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--file", "--range", "--page"] });
    return claimsInputSchema.parse({
      file: flags.optional("--file"),
      range: flags.optional("--range") ?? "7d",
      page: flags.optionalNonNegativeInteger("--page") ?? 1,
    });
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/stats/claims", { cwd, ...input });
  },
}), defineWorkbenchAgentCommand({
  words: ["stats", "feedback"],
  usage: FEEDBACK_USAGE,
  workbenchRootUsage: `${FEEDBACK_USAGE} [--channel wb --all-projects]`,
  description: "List agent feedback for this project, most important first, with each author's model and effort.",
  effects: { readOnly: true, idempotent: true },
  hideFromMcp: true,
  helpGroups: ["stats"],
  inputSchema: feedbackInputSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      boolean: ["--all-projects"], values: ["--channel", "--category", "--sort", "--range", "--page"],
    });
    if (flags.has("--all-projects") && flags.optional("--channel") !== "wb") throw new Error(ALL_PROJECTS_MESSAGE);
    return feedbackInputSchema.parse({
      allProjects: flags.has("--all-projects"),
      category: flags.optional("--category"),
      channel: flags.optional("--channel"),
      page: flags.optionalNonNegativeInteger("--page") ?? 1,
      range: flags.optional("--range") ?? "7d",
      sort: flags.optional("--sort") ?? "importance",
    });
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/stats/feedback", { cwd, ...input });
  },
}), defineWorkbenchAgentCommand({
  words: ["stats", "tools"],
  usage: TOOLS_USAGE,
  // Tool prompt cost is a Workbench concern, so only the Workbench root advertises the cross-project view.
  workbenchRootUsage: `${TOOLS_USAGE} [--all-projects]`,
  description: "Rank wb tools by calls per 100 always-on prompt tokens (spec plus docs), lowest value first, with tool waste per thread.",
  effects: { readOnly: true, idempotent: true },
  hideFromMcp: true,
  helpGroups: ["stats"],
  inputSchema: toolsInputSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--all-projects", "--descending"], values: ["--range", "--sort"] });
    return toolsInputSchema.parse({
      allProjects: flags.has("--all-projects"),
      descending: flags.has("--descending"),
      range: flags.optional("--range") ?? "7d",
      sort: flags.optional("--sort") ?? "value",
    });
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/stats/tools", { cwd, ...input });
  },
})] as const;
