/*
 * Exports:
 * - THREAD_AUTO_RESUME_LIMITS: settings slider bounds and increments.
 * - ThreadAutoResumeSettingsSchema/ThreadAutoResumeSettings: whether threads auto resume, unless idle past a threshold.
 * - THREAD_AUTO_RESUME_DEFAULTS: settings before any edit.
 * - ThreadAutoResumePatchSchema/ThreadAutoResumePatch: validated partial edits.
 */
import { z } from "zod";

export const THREAD_AUTO_RESUME_LIMITS = { idleMinutes: { min: 10, max: 120, step: 10 } } as const;

const minutes = z.number().int()
  .min(THREAD_AUTO_RESUME_LIMITS.idleMinutes.min).max(THREAD_AUTO_RESUME_LIMITS.idleMinutes.max).multipleOf(THREAD_AUTO_RESUME_LIMITS.idleMinutes.step);

export const ThreadAutoResumeSettingsSchema = z.object({ enabled: z.boolean(), idleMinutes: minutes }).strict();
export type ThreadAutoResumeSettings = z.infer<typeof ThreadAutoResumeSettingsSchema>;

export const THREAD_AUTO_RESUME_DEFAULTS: ThreadAutoResumeSettings = Object.freeze({ enabled: true, idleMinutes: 60 });

export const ThreadAutoResumePatchSchema = ThreadAutoResumeSettingsSchema.partial().strict();
export type ThreadAutoResumePatch = z.infer<typeof ThreadAutoResumePatchSchema>;
