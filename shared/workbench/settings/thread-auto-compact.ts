/*
 * Exports:
 * - ThreadAutoCompactSettingsSchema/ThreadAutoCompactSettings: daemon-wide idle compaction configuration.
 * - THREAD_AUTO_COMPACT_LIMITS: settings slider bounds and increments.
 * - DEFAULT_THREAD_AUTO_COMPACT_SETTINGS: initial daemon policy.
 * - ThreadAutoCompactSettingsPatchSchema: validated partial field edits.
 */
import { z } from "zod";

export const THREAD_AUTO_COMPACT_LIMITS = {
  tokens: { min: 25_000, max: 1_000_000, step: 25_000 },
  idleMinutes: { min: 10, max: 120, step: 10 },
} as const;

const fields = {
  enabled: z.boolean(),
  tokenThreshold: z.number().int().min(THREAD_AUTO_COMPACT_LIMITS.tokens.min).max(THREAD_AUTO_COMPACT_LIMITS.tokens.max).multipleOf(THREAD_AUTO_COMPACT_LIMITS.tokens.step),
  idleMinutes: z.number().int().min(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.min).max(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.max).multipleOf(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.step),
};
export const ThreadAutoCompactSettingsSchema = z.object({
  enabled: fields.enabled.default(true),
  tokenThreshold: fields.tokenThreshold.default(200_000),
  idleMinutes: fields.idleMinutes.default(30),
}).strict();

export type ThreadAutoCompactSettings = z.infer<typeof ThreadAutoCompactSettingsSchema>;
export const DEFAULT_THREAD_AUTO_COMPACT_SETTINGS: ThreadAutoCompactSettings = ThreadAutoCompactSettingsSchema.parse({});
export const ThreadAutoCompactSettingsPatchSchema = z.object(fields).partial().strict();
