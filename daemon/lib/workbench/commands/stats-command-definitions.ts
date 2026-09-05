/*
 * Keywords: CLI, stats, claim traffic, read-only.
 * Exports:
 * - WorkbenchClaimStatsExecutionRequestSchema: validate cwd-owned claim analysis.
 * - WORKBENCH_STATS_COMMANDS: CLI-only claim ranking and file-thread reads.
 */
import { z } from "zod";
import { WorkbenchClaimStatsRangeSchema } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const inputSchema = z.object({
  file: z.string().trim().min(1).max(2_000).nullable().default(null),
  range: WorkbenchClaimStatsRangeSchema.default("7d"),
  page: z.number().int().min(1).max(1_000_000).default(1),
}).strict();
export const WorkbenchClaimStatsExecutionRequestSchema = inputSchema.extend({
  cwd: z.string().trim().min(1),
}).strict();

export const WORKBENCH_STATS_COMMANDS = [defineWorkbenchAgentCommand({
  words: ["stats", "claims"],
  usage: "wb stats claims [--file <root:path>] [--range <7d|14d|30d|90d|365d|all>] [--page <n>]",
  description: "Rank files by distinct claiming threads, or list one file's claiming thread titles and ids.",
  effects: { readOnly: true, idempotent: true },
  hideFromMcp: true,
  helpGroups: ["stats"],
  inputSchema,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--file", "--range", "--page"] });
    return inputSchema.parse({
      file: flags.optional("--file"),
      range: flags.optional("--range") ?? "7d",
      page: flags.optionalNonNegativeInteger("--page") ?? 1,
    });
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/stats/claims", { cwd, ...input });
  },
})] as const;
