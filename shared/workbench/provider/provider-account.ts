/*
 * Exports:
 * - WorkbenchRateLimitWindowSchema/WorkbenchRateLimitWindow: quota usage and reset time.
 * - WorkbenchRateLimitSnapshotSchema/WorkbenchRateLimitSnapshot: account display facts.
 * - WorkbenchAccountLimitsSchema/WorkbenchAccountLimits: default and named quota snapshots.
 */
import { z } from "zod";

export const WorkbenchRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});
export type WorkbenchRateLimitWindow = z.infer<typeof WorkbenchRateLimitWindowSchema>;

export const WorkbenchRateLimitSnapshotSchema = z.object({
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: WorkbenchRateLimitWindowSchema.nullable(),
  secondary: WorkbenchRateLimitWindowSchema.nullable(),
  credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() }).nullable(),
  individualLimit: z.object({
    limit: z.string(), used: z.string(), remainingPercent: z.number(), resetsAt: z.number(),
  }).nullable().default(null),
  spendControlReached: z.boolean().nullable().default(null),
  planType: z.string().nullable(),
  rateLimitReachedType: z.string().nullable().default(null),
});
export type WorkbenchRateLimitSnapshot = z.infer<typeof WorkbenchRateLimitSnapshotSchema>;

export const WorkbenchAccountLimitsSchema = z.object({
  preferredLimitId: z.string().nullable().default(null),
  rateLimits: WorkbenchRateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), WorkbenchRateLimitSnapshotSchema).nullable(),
});
export type WorkbenchAccountLimits = z.infer<typeof WorkbenchAccountLimitsSchema>;
