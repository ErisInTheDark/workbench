/*
 * Exports:
 * - THREAD_AUTO_COMPACT_LIMITS: settings slider bounds and increments.
 * - ThreadAutoCompactRulesSchema/ThreadAutoCompactRules: one provider's compaction rules, and pure edits and timing over them.
 * - ThreadAutoCompactSettingsSchema/ThreadAutoCompactSettings: every installed provider's rules.
 * - THREAD_AUTO_COMPACT_DEFAULTS: initial per-provider rules.
 * - ThreadAutoCompactPatchSchema/ThreadAutoCompactPatch: validated partial edits to one provider's rules.
 * - ThreadAutoCompactUpdateSchema/ThreadAutoCompactUpdate: one provider's edit request.
 * - ThreadAutoCompactTiming: when a thread's rules make compaction due, and which rule did.
 */
import { z } from "zod";
import { installedProviderKeys, type WorkbenchProviderKey } from "../provider/provider-registrations.ts";

export const THREAD_AUTO_COMPACT_LIMITS = {
  tokens: { min: 25_000, max: 1_000_000, step: 25_000 },
  idleMinutes: { min: 10, max: 120, step: 10 },
} as const;

const tokens = z.number().int()
  .min(THREAD_AUTO_COMPACT_LIMITS.tokens.min).max(THREAD_AUTO_COMPACT_LIMITS.tokens.max).multipleOf(THREAD_AUTO_COMPACT_LIMITS.tokens.step);
const minutes = z.number().int()
  .min(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.min).max(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.max).multipleOf(THREAD_AUTO_COMPACT_LIMITS.idleMinutes.step);

export const ThreadAutoCompactRulesSchema = z.object({
  enabled: z.boolean(),
  /** Compact once idle past the provider's cache lifetime; null where the provider's cache never expires. */
  idle: z.object({ tokenThreshold: tokens, minutes }).strict().nullable(),
  /** Compact before the next message whenever a turn ends above this. */
  turnEndTokenThreshold: tokens,
}).strict().refine(rules => !rules.idle || rules.turnEndTokenThreshold >= rules.idle.tokenThreshold, {
  message: "The turn-end threshold cannot be below the idle threshold.",
});
export type ThreadAutoCompactRules = z.infer<typeof ThreadAutoCompactRulesSchema>;

export const ThreadAutoCompactSettingsSchema = z.object(Object.fromEntries(
  installedProviderKeys.map(key => [key, ThreadAutoCompactRulesSchema]),
) as Record<WorkbenchProviderKey, typeof ThreadAutoCompactRulesSchema>).strict();
export type ThreadAutoCompactSettings = Record<WorkbenchProviderKey, ThreadAutoCompactRules>;

export const THREAD_AUTO_COMPACT_DEFAULTS: ThreadAutoCompactSettings = Object.freeze({
  claude: { enabled: true, idle: { tokenThreshold: 200_000, minutes: 60 }, turnEndTokenThreshold: 500_000 },
  opencode: { enabled: true, idle: { tokenThreshold: 200_000, minutes: 30 }, turnEndTokenThreshold: 500_000 },
  codex: { enabled: true, idle: null, turnEndTokenThreshold: 500_000 },
});

export const ThreadAutoCompactPatchSchema = z.object({
  enabled: z.boolean(),
  tokenThreshold: tokens,
  idleMinutes: minutes,
  turnEndTokenThreshold: tokens,
}).partial().strict();
export type ThreadAutoCompactPatch = z.infer<typeof ThreadAutoCompactPatchSchema>;

export const ThreadAutoCompactUpdateSchema = z.object({
  provider: z.enum(installedProviderKeys as [WorkbenchProviderKey, ...WorkbenchProviderKey[]]),
  settings: ThreadAutoCompactPatchSchema,
}).strict();
export type ThreadAutoCompactUpdate = z.infer<typeof ThreadAutoCompactUpdateSchema>;

export type ThreadAutoCompactTiming = { rule: "turnEnd" | "idle"; dueAt: number };

export const ThreadAutoCompactRules = {
  /** Raising the idle threshold carries the turn-end threshold with it; idle edits on a provider without the rule are refused. */
  apply(current: ThreadAutoCompactRules, patch: ThreadAutoCompactPatch): ThreadAutoCompactRules {
    if (!current.idle && (patch.tokenThreshold !== undefined || patch.idleMinutes !== undefined)) {
      throw new Error("This provider has no idle compaction rule.");
    }
    const idle = current.idle && {
      tokenThreshold: patch.tokenThreshold ?? current.idle.tokenThreshold,
      minutes: patch.idleMinutes ?? current.idle.minutes,
    };
    const turnEndTokenThreshold = patch.turnEndTokenThreshold ?? current.turnEndTokenThreshold;
    return ThreadAutoCompactRulesSchema.parse({
      enabled: patch.enabled ?? current.enabled,
      idle,
      turnEndTokenThreshold: idle ? Math.max(turnEndTokenThreshold, idle.tokenThreshold) : turnEndTokenThreshold,
    });
  },

  /** Null when no rule applies; an idle rule's time is when the cache would have expired anyway. */
  timing(rules: ThreadAutoCompactRules | undefined, evidence: { activityAt: number; contextTokens: number | null }): ThreadAutoCompactTiming | null {
    if (!rules?.enabled || evidence.contextTokens === null) return null;
    if (evidence.contextTokens >= rules.turnEndTokenThreshold) return { rule: "turnEnd", dueAt: evidence.activityAt };
    if (!rules.idle || evidence.contextTokens < rules.idle.tokenThreshold) return null;
    return { rule: "idle", dueAt: evidence.activityAt + rules.idle.minutes * 60_000 };
  },
};
