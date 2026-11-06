/*
 * Exports:
 * - ThreadAutoResumeSettingsSchema/ThreadAutoResumeSettings: whether threads auto resume, and what one with an expired cache does.
 * - THREAD_AUTO_RESUME_DEFAULTS: settings before any edit.
 * - ThreadAutoResumePatchSchema/ThreadAutoResumePatch: validated partial edits.
 * - ThreadAutoResumeRules: what an auto resume does when compaction is due.
 */
import { z } from "zod";
import type { ThreadAutoCompactAction, ThreadAutoCompactCause } from "./thread-auto-compact.ts";

export const ThreadAutoResumeSettingsSchema = z.object({
  enabled: z.boolean(),
  expiredCache: z.enum(["wait", "compact"]),
}).strict();
export type ThreadAutoResumeSettings = z.infer<typeof ThreadAutoResumeSettingsSchema>;

export const THREAD_AUTO_RESUME_DEFAULTS: ThreadAutoResumeSettings = Object.freeze({ enabled: true, expiredCache: "compact" });

export const ThreadAutoResumePatchSchema = ThreadAutoResumeSettingsSchema.partial().strict();
export type ThreadAutoResumePatch = z.infer<typeof ThreadAutoResumePatchSchema>;

export const ThreadAutoResumeRules = {
  /** Size-only compaction exists for the user's next turn, so it never delays a resume; an expired cache is the user's call. */
  whenCompactionDue(settings: Pick<ThreadAutoResumeSettings, "expiredCache">, cause: ThreadAutoCompactCause): ThreadAutoCompactAction {
    if (cause === "tooMuchContext") return "admit";
    return settings.expiredCache === "compact" ? "compact" : "hold";
  },
};
