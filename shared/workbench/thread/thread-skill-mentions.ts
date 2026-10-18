/*
 * Exports:
 * - workbenchSkillMentionAliases: the names a skill answers to after `/`: its name and its `skills/<dir>/SKILL.md` folder.
 * - resolveWorkbenchSkillMention: the one skill a `/value` names, or null when none or several match.
 * - readWorkbenchSkillMentionPaths: skill paths activated by `/skill` mentions in typed text, ignoring hidden Workbench blocks.
 * - WorkbenchSkillActivationMismatchSchema/WorkbenchSkillActivationMismatch: daemon rejection data with the activatable skills.
 * - WorkbenchSkillActivationMismatchError: a message's claimed skill activations disagree with the daemon's catalog.
 * - assertWorkbenchSkillActivations: reject claimed activations that differ from the ones the texts name.
 * - readWorkbenchSkillActivationMismatch: read rejection data off a daemon request error.
 */
import { z } from "zod";
import type { WorkbenchSkillSummary } from "../../types.ts";

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)}\]]+$/u;

function normalizeMentionPath(value: string) {
  return value.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/{2,}/gu, "/");
}

export function workbenchSkillMentionAliases(skill: Pick<WorkbenchSkillSummary, "name" | "relativePath">) {
  const directory = /^(?:\.agents\/)?skills\/(?:builtin\/)?([^/]+)\/SKILL\.md$/iu.exec(normalizeMentionPath(skill.relativePath))?.[1] ?? "";
  return [...new Set([skill.name, directory].filter(Boolean))];
}

export function resolveWorkbenchSkillMention<Skill extends { aliases: readonly string[]; path: string }>(
  value: string, skills: readonly Skill[],
): Skill | null {
  const normalized = value.toLocaleLowerCase();
  const matches = skills.filter(skill => skill.aliases.some(alias => alias.toLocaleLowerCase() === normalized));
  return matches.length === 1 ? matches[0]! : null;
}

/** Workbench blocks (composer references, questionnaire answers, skill transport) are not text the user typed. */
const WORKBENCH_BLOCK_PATTERN = /^<(wb:[a-z][a-z0-9:-]*)(?: [^\n>]*)?>\n[\s\S]*?\n<\/\1>$/gmu;

/**
 * A `/` at the start or after whitespace names a skill when its token, or the token without trailing punctuation,
 * matches exactly one. Only typed text counts: the same text the composer highlights.
 */
export function readWorkbenchSkillMentionPaths(texts: readonly string[], skills: readonly WorkbenchSkillSummary[]) {
  const candidates = skills.map(skill => ({ aliases: workbenchSkillMentionAliases(skill), path: skill.path }));
  const paths = new Set<string>();
  for (const text of texts) {
    for (const match of text.replace(/\r\n?/gu, "\n").replace(WORKBENCH_BLOCK_PATTERN, "").matchAll(/(?<!\S)\/(\S+)/gu)) {
      const raw = match[1]!;
      const skill = resolveWorkbenchSkillMention(raw, candidates)
        ?? resolveWorkbenchSkillMention(raw.replace(TRAILING_PUNCTUATION_PATTERN, ""), candidates);
      if (skill) paths.add(skill.path);
    }
  }
  return [...paths];
}

export const WorkbenchSkillActivationMismatchSchema = z.object({
  /** Claimed activations the daemon cannot activate. */
  unknownPaths: z.array(z.string()),
  /** Skills the message names that the client did not activate. */
  missedPaths: z.array(z.string()),
  activatableSkills: z.array(z.object({
    name: z.string(), description: z.string(), path: z.string(), relativePath: z.string(),
  })),
});
export type WorkbenchSkillActivationMismatch = z.infer<typeof WorkbenchSkillActivationMismatchSchema>;

/** Unknown skills have no catalog name; their `.../<dir>/SKILL.md` folder is the name the user typed. */
function skillLabel(path: string, skills: readonly WorkbenchSkillSummary[]) {
  return `/${skills.find(skill => skill.path === path)?.name ?? path.split(/[\\/]/u).at(-2) ?? path}`;
}

export class WorkbenchSkillActivationMismatchError extends Error {
  constructor(readonly mismatch: WorkbenchSkillActivationMismatch) {
    const { unknownPaths, missedPaths, activatableSkills } = mismatch;
    super(unknownPaths.length
      ? `Skill activation ${unknownPaths.map(path => skillLabel(path, [])).join(", ")} doesn't exist for this thread. Remove it or check why it isn't available.`
      : `${missedPaths.map(path => skillLabel(path, activatableSkills)).join(", ")} is available but wasn't activated. Skills were refreshed; send again.`);
    this.name = "WorkbenchSkillActivationMismatchError";
  }
}

export function assertWorkbenchSkillActivations(
  claimedPaths: readonly string[], texts: readonly string[], skills: readonly WorkbenchSkillSummary[],
) {
  const named = new Set(readWorkbenchSkillMentionPaths(texts, skills));
  const claimed = new Set(claimedPaths.map(path => path.trim()).filter(Boolean));
  const unknownPaths = [...claimed].filter(path => !named.has(path));
  const missedPaths = [...named].filter(path => !claimed.has(path));
  if (unknownPaths.length || missedPaths.length) {
    throw new WorkbenchSkillActivationMismatchError({ unknownPaths, missedPaths, activatableSkills: [...skills] });
  }
}

export function readWorkbenchSkillActivationMismatch(error: unknown): WorkbenchSkillActivationMismatch | null {
  const data = error && typeof error === "object" && "data" in error ? (error as { data: unknown }).data : null;
  const parsed = WorkbenchSkillActivationMismatchSchema.safeParse(
    data && typeof data === "object" && "skillActivationMismatch" in data ? data.skillActivationMismatch : undefined,
  );
  return parsed.success ? parsed.data : null;
}
