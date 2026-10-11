/*
 * Exports:
 * - ThreadSummaryFactsSchema/ThreadSummaryFacts: live per-thread facts every thread display can show; unknown keys strip, so new facts never need a version.
 * - ThreadSummarySchema/ThreadSummary: one thread's canonical summary: its lean row plus its live facts.
 * - LocatedThreadSummarySchema/LocatedThreadSummary: a daemon's summary of a thread it holds, with its owner project.
 * - LocatedThreadSummariesSchema: located summaries keyed by thread id; null marks a thread the daemon does not hold.
 * - createThreadSummary: build a summary from a full entry or lean row and its facts, dropping empty facts.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";
import type { WorkbenchThreadSidebarEntry } from "./thread-state";
import {
  projectSidebarRow,
  WorkbenchThreadSidebarThreadRowSchema,
  type WorkbenchThreadSidebarRow,
  type WorkbenchThreadSidebarThreadRow,
} from "./thread-sidebar-row";

export const ThreadSummaryFactsSchema = z.object({
  /** Context compaction is running now. */
  compacting: z.boolean().optional(),
  /** Required follow-up todos the thread still holds; they keep it from settling. */
  requiredTodoCount: z.number().int().nonnegative().optional(),
});
export type ThreadSummaryFacts = z.infer<typeof ThreadSummaryFactsSchema>;

export const ThreadSummarySchema = z.object({
  facts: ThreadSummaryFactsSchema,
  row: WorkbenchThreadSidebarThreadRowSchema,
}).strict();
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** A daemon's summary of a thread it holds, with the project holding it, so callers can locate it without an owner lookup. */
export const LocatedThreadSummarySchema = z.object({
  projectId: ProjectIdSchema,
  summary: ThreadSummarySchema,
}).strict();
export type LocatedThreadSummary = z.infer<typeof LocatedThreadSummarySchema>;

export const LocatedThreadSummariesSchema = z.record(z.string().min(1), LocatedThreadSummarySchema.nullable());

type ThreadSource = Exclude<WorkbenchThreadSidebarEntry | WorkbenchThreadSidebarRow, { entryKind: "draft" }>;

/** False and zero facts are the default reading, so they are omitted and summaries stay identical when nothing is live. */
export function createThreadSummary(entry: ThreadSource, facts: ThreadSummaryFacts): ThreadSummary {
  return {
    facts: {
      ...(facts.compacting ? { compacting: true } : {}),
      ...(facts.requiredTodoCount ? { requiredTodoCount: facts.requiredTodoCount } : {}),
    },
    row: projectSidebarRow(entry) as WorkbenchThreadSidebarThreadRow,
  };
}
