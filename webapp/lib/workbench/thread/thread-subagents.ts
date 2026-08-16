/*
 * Exports:
 * - mergeWorkbenchSubagentSummaries/reconcileWorkbenchSubagentPage/getSubagentThreadIds/getSubagentSummary/getSubagentHarness/filterSubagentsByParentThreadId/filterSubagentThreadSummaries: merge, reconcile, derive, and filter direct-child identity from pushed summaries. Keywords: workbench, thread, subagent, metadata, harness, sidebar.
 * - sortWorkbenchSubagents/getSubagentTabLayout/getNextSubagentHydrationBatch: derive lifecycle/Lock order, settled folding, and bounded body hydration. Keywords: subagent, tabs, lock, lifecycle, hydration.
 * - getThreadAgentAccentColor/getThreadAgentLabelParts/getThreadAgentTabLabel: parent-derived child colors and metadata-first labels. Keywords: subagent, color, hue, label, tabs.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchSubagentSummary } from "../../types";
import { areDeeplyEqual } from "../deep-equality";

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;
const SUBAGENT_HUE_ROTATION_DEGREES = 1080 / 23;
const SUBAGENT_BACKGROUND_BATCH_SIZE = 4;

function normalizeLabel(value: string | null | undefined) {
  return value?.trim() || null;
}

function hashThreadId(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function sortWorkbenchSubagents(subagents: readonly WorkbenchSubagentSummary[]) {
  return subagents.slice().sort((left, right) => (
    lifecycleRank(left) - lifecycleRank(right)
    || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || right.lastActivityAt - left.lastActivityAt
    || right.createdAt - left.createdAt
    || left.threadId.localeCompare(right.threadId)
  ));
}

function lifecycleRank(subagent: WorkbenchSubagentSummary) {
  if (subagent.lifecycle?.kind === "needsAttention") return 0;
  if ((subagent.lifecycle?.kind === "completed" || subagent.lifecycle?.kind === "stopped") && !subagent.lifecycle.settled) return 1;
  if (subagent.lifecycle?.kind === "working") return 2;
  return 3;
}

export function getSubagentTabLayout(
  subagents: readonly WorkbenchSubagentSummary[],
  {
    revealedThreadIds = new Set<string>(),
  }: {
    revealedThreadIds?: ReadonlySet<string>;
  } = {},
) {
  const visible: WorkbenchSubagentSummary[] = [];
  const collapsed: WorkbenchSubagentSummary[] = [];
  for (const subagent of sortWorkbenchSubagents(subagents)) {
    const isSettled = Boolean(subagent.lifecycle?.settled);
    (isSettled && !revealedThreadIds.has(subagent.threadId) ? collapsed : visible).push(subagent);
  }
  return { collapsed, visible };
}

export function getNextSubagentHydrationBatch({
  loadedThreadIds,
  loadingThreadIds,
  threadIds,
}: {
  loadedThreadIds: ReadonlySet<string>;
  loadingThreadIds: ReadonlySet<string>;
  threadIds: readonly string[];
}) {
  return threadIds
    .filter((threadId) => !loadedThreadIds.has(threadId) && !loadingThreadIds.has(threadId))
    .slice(0, SUBAGENT_BACKGROUND_BATCH_SIZE);
}

export function getSubagentThreadIds(subagents: readonly WorkbenchSubagentSummary[]) {
  return subagents.map((record) => record.threadId);
}

export function mergeWorkbenchSubagentSummaries(
  summaryGroups: readonly (readonly WorkbenchSubagentSummary[])[],
) {
  const summariesByThreadId = new Map<string, WorkbenchSubagentSummary>();
  for (const summaries of summaryGroups) {
    for (const summary of summaries) {
      const previous = summariesByThreadId.get(summary.threadId);
      if (!previous || summary.updatedAt > previous.updatedAt) {
        summariesByThreadId.set(summary.threadId, summary);
      }
    }
  }
  return Array.from(summariesByThreadId.values()).sort((left, right) => (
    left.createdAt - right.createdAt
    || left.threadId.localeCompare(right.threadId)
  ));
}

export function reconcileWorkbenchSubagentPage({
  current,
  fallback,
  pageSubagents,
  preserveAdditionalPages,
}: {
  current: WorkbenchSubagentSummary[] | null;
  fallback: readonly WorkbenchSubagentSummary[];
  pageSubagents: WorkbenchSubagentSummary[];
  preserveAdditionalPages: boolean;
}): WorkbenchSubagentSummary[] | null {
  const nextSubagents = preserveAdditionalPages && current
    ? [
      ...pageSubagents,
      ...current.filter((summary) => !pageSubagents.some((pageSummary) => pageSummary.threadId === summary.threadId)),
    ]
    : pageSubagents;
  return areDeeplyEqual(current ?? fallback, nextSubagents) ? current : nextSubagents;
}

export function getSubagentSummary(subagents: readonly WorkbenchSubagentSummary[], threadId: string) {
  return subagents.find((record) => record.threadId === threadId) ?? null;
}

export function getSubagentHarness(
  subagents: readonly WorkbenchSubagentSummary[],
  threadId: string,
  fallbackHarness: WorkbenchSubagentSummary["harness"],
) {
  return getSubagentSummary(subagents, threadId)?.harness ?? fallbackHarness;
}

export function filterSubagentsByParentThreadId(
  subagents: readonly WorkbenchSubagentSummary[],
  parentThreadId: string,
) {
  return subagents.filter((record) => record.parentThreadId === parentThreadId);
}

export function filterSubagentThreadSummaries(
  threads: readonly ThreadSummary[],
  subagentThreadIds: ReadonlySet<string>,
) {
  return subagentThreadIds.size
    ? threads.filter((thread) => !subagentThreadIds.has(thread.id))
    : threads.slice();
}

export function getThreadAgentLabelParts(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  subagent?: WorkbenchSubagentSummary | null,
): ThreadAgentLabelParts {
  const role = normalizeLabel(thread?.agentRole);
  const nickname = normalizeLabel(subagent?.name) ?? normalizeLabel(thread?.agentNickname);
  return {
    nickname,
    role,
    text: nickname && role && nickname !== role
      ? `${nickname} (${role})`
      : nickname ?? role ?? "subagent",
  };
}

export function getThreadAgentAccentColor(
  subagent: Pick<WorkbenchSubagentSummary, "directSubagentIndex" | "parentThreadId">,
  chromaPercent = 90,
) {
  const startingHue = hashThreadId(subagent.parentThreadId) % 360;
  const hue = (startingHue + SUBAGENT_HUE_ROTATION_DEGREES * subagent.directSubagentIndex) % 360;
  return `oklch(var(--oklch-text-lightness) ${chromaPercent}% ${hue}deg)`;
}

export function getThreadAgentTabLabel(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  subagent?: WorkbenchSubagentSummary | null,
) {
  return getThreadAgentLabelParts(thread, subagent).text;
}
