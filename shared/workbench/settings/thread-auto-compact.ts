/*
 * Exports:
 * - THREAD_AUTO_COMPACT_LIMITS: settings slider bounds and increments.
 * - ThreadAutoCompactRulesSchema/ThreadAutoCompactRules: one provider's compaction rules, and pure edits and timing over them.
 * - ThreadAutoCompactSettingsSchema/ThreadAutoCompactSettings: every installed provider's rules.
 * - THREAD_AUTO_COMPACT_DEFAULTS: initial per-provider rules.
 * - ThreadAutoCompactPatchSchema/ThreadAutoCompactPatch: validated partial edits to one provider's rules.
 * - ThreadAutoCompactUpdateSchema/ThreadAutoCompactUpdate: one provider's edit request.
 * - ThreadAutoCompactCauseSchema/ThreadAutoCompactCause: why compaction is due: the provider's cache expired, or the context is simply too large.
 * - ThreadAutoCompactAssessment: a thread's current compaction cause, and when that answer next changes.
 * - ThreadAutoCompactAction: what one admission does about a due compaction.
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

export const ThreadAutoCompactCauseSchema = z.enum(["noCache", "tooMuchContext"]);
export type ThreadAutoCompactCause = z.infer<typeof ThreadAutoCompactCauseSchema>;

export type ThreadAutoCompactAssessment = { cause: ThreadAutoCompactCause | null; changesAt: number | null };

/** What one admission does about a due compaction: compact first, go ahead without, or leave the thread untouched. */
export type ThreadAutoCompactAction = "compact" | "admit" | "hold";

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

  /**
   * Why compaction is due at `now` and when that answer next changes; null when no rule applies.
   * A thread both too big and cold counts as cold, because replaying it uncached is the costlier fact.
   */
  assess(
    rules: ThreadAutoCompactRules | undefined,
    evidence: { activityAt: number; contextTokens: number | null },
    now: number,
    prefixStale = false,
  ): ThreadAutoCompactAssessment | null {
    if (!rules?.enabled || evidence.contextTokens === null) return null;
    const expiresAt = rules.idle && evidence.contextTokens >= rules.idle.tokenThreshold
      ? evidence.activityAt + rules.idle.minutes * 60_000 : null;
    if (expiresAt !== null && (prefixStale || now >= expiresAt)) return { cause: "noCache", changesAt: null };
    if (evidence.contextTokens >= rules.turnEndTokenThreshold) return { cause: "tooMuchContext", changesAt: expiresAt };
    return expiresAt === null ? null : { cause: null, changesAt: expiresAt };
  },
};
