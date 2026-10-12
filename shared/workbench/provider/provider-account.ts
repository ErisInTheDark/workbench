/*
 * Exports:
 * - WorkbenchRateLimitWindowSchema/WorkbenchRateLimitWindow: quota usage and reset time.
 * - WorkbenchRateLimitSnapshotSchema/WorkbenchRateLimitSnapshot: account display facts.
 * - WorkbenchAccountIdentitySchema/WorkbenchAccountIdentity: which signed-in account a limits read belongs to.
 * - WorkbenchAccountLimitsSchema/WorkbenchAccountLimits: default and named quota snapshots, with their account.
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
  tertiary: WorkbenchRateLimitWindowSchema.nullable().optional(),
  credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() }).nullable(),
  individualLimit: z.object({
    limit: z.string(), used: z.string(), remainingPercent: z.number(), resetsAt: z.number(),
  }).nullable().default(null),
  spendControlReached: z.boolean().nullable().default(null),
  planType: z.string().nullable(),
  rateLimitReachedType: z.string().nullable().default(null),
});
export type WorkbenchRateLimitSnapshot = z.infer<typeof WorkbenchRateLimitSnapshotSchema>;

/** Which account the limits belong to: a one-way fingerprint that tells accounts apart, and an optional private display label. */
export const WorkbenchAccountIdentitySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{16,64}$/u),
  label: z.string().min(1).max(320).nullable(),
});
export type WorkbenchAccountIdentity = z.infer<typeof WorkbenchAccountIdentitySchema>;

export const WorkbenchAccountLimitsSchema = z.object({
  preferredLimitId: z.string().nullable().default(null),
  rateLimits: WorkbenchRateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), WorkbenchRateLimitSnapshotSchema).nullable(),
  /** Absent or null when the provider cannot say which account is signed in. */
  identity: WorkbenchAccountIdentitySchema.nullish(),
});
export type WorkbenchAccountLimits = z.infer<typeof WorkbenchAccountLimitsSchema>;
