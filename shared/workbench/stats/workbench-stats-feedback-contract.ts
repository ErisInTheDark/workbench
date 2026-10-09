/*
 * Exports:
 * - WORKBENCH_FEEDBACK_CHANNELS/WorkbenchFeedbackChannelSchema/WorkbenchFeedbackChannel: who the friction is about, Workbench or the project.
 * - WORKBENCH_FEEDBACK_CATEGORIES/WorkbenchFeedbackCategorySchema/WorkbenchFeedbackCategory: kind of friction.
 * - WORKBENCH_FEEDBACK_TITLE_FALLBACK: presentation title for historical reports recorded before titles existed.
 * - WorkbenchFeedbackTitleSchema: bounded single-line report title.
 * - WorkbenchFeedbackReportSchema: bounded agent report text.
 * - WORKBENCH_FEEDBACK_SORTS/WorkbenchFeedbackSort: importance-first or newest-first ordering.
 * - WorkbenchFeedbackItemSchema/WorkbenchFeedbackItem: one report with its author's model, effort, and computed importance.
 * - WorkbenchStatsFeedbackSchema/WorkbenchStatsFeedback/EMPTY_WORKBENCH_STATS_FEEDBACK/WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT: the stats view's feedback section; wb reports belong to the Workbench project.
 * - WorkbenchFeedbackRecord: trusted, cwd-resolved feedback write.
 * - WorkbenchFeedbackReadRequest/WorkbenchFeedbackReadResponse/WORKBENCH_FEEDBACK_PAGE_SIZE: paged agent read.
 */
import { z } from "zod";
import { ProviderKeySchema } from "../provider/provider-key.ts";
import type { ProjectId, WorkbenchThreadId } from "../identity.ts";
import type { WorkbenchClaimStatsRangeSchema } from "./workbench-stats-claims-contract.ts";

export const WORKBENCH_FEEDBACK_CHANNELS = ["wb", "project"] as const;
export const WorkbenchFeedbackChannelSchema = z.enum(WORKBENCH_FEEDBACK_CHANNELS);
export type WorkbenchFeedbackChannel = z.infer<typeof WorkbenchFeedbackChannelSchema>;

export const WORKBENCH_FEEDBACK_CATEGORIES = ["bug", "waste", "confusion", "opportunity"] as const;
export const WorkbenchFeedbackCategorySchema = z.enum(WORKBENCH_FEEDBACK_CATEGORIES);
export type WorkbenchFeedbackCategory = z.infer<typeof WorkbenchFeedbackCategorySchema>;

export const WORKBENCH_FEEDBACK_TITLE_FALLBACK = "Feedback report";
export const WorkbenchFeedbackTitleSchema = z.string().trim().min(1).max(120)
  .refine((value) => !/[\r\n]/u.test(value), "Title must be one line");
export const WorkbenchFeedbackReportSchema = z.string().trim().min(1).max(4_000);

export const WORKBENCH_FEEDBACK_SORTS = ["importance", "newest"] as const;
export type WorkbenchFeedbackSort = typeof WORKBENCH_FEEDBACK_SORTS[number];

const count = z.number().int().nonnegative();
const unit = z.number().finite().min(0).max(1);

export const WorkbenchFeedbackItemSchema = z.object({
  id: count,
  category: WorkbenchFeedbackCategorySchema,
  channel: WorkbenchFeedbackChannelSchema,
  createdAt: z.number().finite().nonnegative(),
  /** The daemon storing the report, once merged across machines; ids are only unique per daemon. */
  daemonId: z.string().min(1).nullish(),
  harness: ProviderKeySchema.nullable(),
  /** 0 to 1; how much the author's model and effort make this report worth reading. */
  importance: unit,
  model: z.string().max(200).nullable(),
  projectId: z.string().min(1),
  reasoningEffort: z.string().max(50).nullable(),
  report: z.string().max(4_000),
  /** False when the author's model is missing from the trust registry and scored at its median. */
  scored: z.boolean(),
  /** Null once the authoring thread is gone. */
  threadId: z.string().min(1).nullable(),
  // Old servers send the source thread title (up to 500 chars) here; keep either reload order readable.
  title: z.string().max(500).nullable().transform((value) => value?.trim().slice(0, 120) || WORKBENCH_FEEDBACK_TITLE_FALLBACK),
}).strict();
export type WorkbenchFeedbackItem = z.infer<typeof WorkbenchFeedbackItemSchema>;

export const WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT = 200;
export const WorkbenchStatsFeedbackSchema = z.object({
  counts: z.array(z.object({ category: WorkbenchFeedbackCategorySchema, count }).strict()).max(WORKBENCH_FEEDBACK_CATEGORIES.length),
  /** Most important first; viewers filter and reorder locally. */
  items: z.array(WorkbenchFeedbackItemSchema).max(WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT),
  total: count,
  /** The project wb reports belong to, so viewers can name reports filed elsewhere. */
  workbenchProjectId: z.string().min(1).nullable().default(null),
}).strict();
export type WorkbenchStatsFeedback = z.infer<typeof WorkbenchStatsFeedbackSchema>;
export const EMPTY_WORKBENCH_STATS_FEEDBACK: WorkbenchStatsFeedback = { counts: [], items: [], total: 0, workbenchProjectId: null };

export interface WorkbenchFeedbackRecord {
  category: WorkbenchFeedbackCategory;
  channel: WorkbenchFeedbackChannel;
  harness: string;
  model: string | null;
  projectId: ProjectId;
  reasoningEffort: string | null;
  report: string;
  threadId: WorkbenchThreadId;
  title: string;
}

export const WORKBENCH_FEEDBACK_PAGE_SIZE = 20;
export interface WorkbenchFeedbackReadRequest {
  category: WorkbenchFeedbackCategory | null;
  channel: WorkbenchFeedbackChannel | null;
  page: number;
  /** Null reads every project; only wb-channel reads may span projects. */
  projectIds: readonly ProjectId[] | null;
  range: z.infer<typeof WorkbenchClaimStatsRangeSchema>;
  sort: WorkbenchFeedbackSort;
}
export interface WorkbenchFeedbackReadResponse {
  page: number;
  pages: number;
  rows: WorkbenchFeedbackItem[];
}
