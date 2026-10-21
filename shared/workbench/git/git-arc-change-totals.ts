/*
 * Exports:
 * - GitArcLineTotalsSchema/GitArcLineTotals: added and deleted line counts.
 * - GitArcChangeTotalsSchema/GitArcChangeTotals: a change set's file count and line totals, dedicated tests apart from premise.
 * - summarizeGitArcChanges: total per-file counts, counting every line exactly once.
 */
import { z } from "zod";
import { isDedicatedTestFile } from "./dedicated-test-files.ts";

export const GitArcLineTotalsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
}).strict();
export type GitArcLineTotals = z.infer<typeof GitArcLineTotalsSchema>;

export const GitArcChangeTotalsSchema = z.object({
  files: z.number().int().nonnegative(),
  premise: GitArcLineTotalsSchema,
  tests: GitArcLineTotalsSchema,
}).strict();
export type GitArcChangeTotals = z.infer<typeof GitArcChangeTotalsSchema>;

export function summarizeGitArcChanges(changes: readonly ({ path: string } & GitArcLineTotals)[]): GitArcChangeTotals {
  const totals = { files: changes.length, premise: { additions: 0, deletions: 0 }, tests: { additions: 0, deletions: 0 } };
  for (const change of changes) {
    const partition = isDedicatedTestFile(change.path) ? totals.tests : totals.premise;
    partition.additions += change.additions;
    partition.deletions += change.deletions;
  }
  return totals;
}
