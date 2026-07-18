/*
 * Exports:
 * - listWorkbenchSubagents/readWorkbenchSubagentPage: fetch durable project metadata or one bounded parent page without joining thread hydration. Keywords: workbench, thread, subagent, metadata, fetch, pagination.
 * - mergeWorkbenchSubagentSummaries/reconcileWorkbenchSubagentPage/getSubagentThreadIds/getSubagentSummary/getSubagentHarness/filterSubagentsByParentThreadId/filterSubagentThreadSummaries: merge, reconcile, derive, and filter direct-child identity from durable summaries. Keywords: workbench, thread, subagent, metadata, harness, sidebar.
 * - sortWorkbenchSubagents/getSubagentTabLayout/getNextSubagentHydrationBatch/getSubagentPollingBatch: derive pinned-first activity order, stale folding, and bounded background work. Keywords: subagent, tabs, pinned, activity, hydration, polling, batch.
 * - getThreadAgentAccentColor/getThreadAgentLabelParts/getThreadAgentTabLabel: parent-derived child colors and metadata-first labels. Keywords: subagent, color, hue, label, tabs.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchSubagentPage, WorkbenchSubagentSummary } from "../../types";
import { areDeeplyEqual } from "../deep-equality";

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;
type CompatibleWorkbenchSubagentSummary = Omit<WorkbenchSubagentSummary, "directSubagentIndex"> & {
  directSubagentIndex?: number;
};

const SUBAGENT_HUE_ROTATION_DEGREES = 1080 / 23;
const SUBAGENT_STALE_AFTER_MS = 30 * 60_000;
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

function normalizeWorkbenchSubagentSummaries(
  summaries: readonly CompatibleWorkbenchSubagentSummary[],
  fallbackSummaries: readonly WorkbenchSubagentSummary[] = [],
) {
  const fallbackIndexesByThreadId = new Map(
    fallbackSummaries.map(({ directSubagentIndex, threadId }) => [threadId, directSubagentIndex]),
  );
  const summariesByParentThreadId = new Map<string, CompatibleWorkbenchSubagentSummary[]>();
  for (const summary of [...fallbackSummaries, ...summaries]) {
    const siblings = summariesByParentThreadId.get(summary.parentThreadId) ?? [];
    if (!siblings.some(({ threadId }) => threadId === summary.threadId)) siblings.push(summary);
    summariesByParentThreadId.set(summary.parentThreadId, siblings);
  }
  const projectedIndexesByThreadId = new Map<string, number>();
  for (const siblings of summariesByParentThreadId.values()) {
    siblings
      .sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId))
      .forEach(({ threadId }, index) => projectedIndexesByThreadId.set(threadId, index));
  }
  return summaries.map((summary): WorkbenchSubagentSummary => ({
    ...summary,
    directSubagentIndex: Number.isSafeInteger(summary.directSubagentIndex) && Number(summary.directSubagentIndex) >= 0
      ? Number(summary.directSubagentIndex)
      : fallbackIndexesByThreadId.get(summary.threadId) ?? projectedIndexesByThreadId.get(summary.threadId)!,
  }));
}

export async function listWorkbenchSubagents({
  cwd,
  parentThreadId,
  signal,
}: {
  cwd: string;
  parentThreadId?: string | null;
  signal: AbortSignal;
}) {
  const search = new URLSearchParams({ cwd });
  if (parentThreadId?.trim()) search.set("parentThreadId", parentThreadId.trim());
  const response = await fetch(`/api/subagents?${search.toString()}`, {
    cache: "no-store",
    signal,
  });
  const payload = await response.json() as { error?: string; subagents?: CompatibleWorkbenchSubagentSummary[] };
  if (!response.ok) throw new Error(payload.error || "Unable to read Workbench subagents.");
  return normalizeWorkbenchSubagentSummaries(payload.subagents ?? []);
}

export async function readWorkbenchSubagentPage({
  cursor,
  cwd,
  limit = 20,
  parentThreadId,
  fallbackSubagents = [],
  signal,
}: {
  cursor?: string | null;
  cwd: string;
  limit?: number;
  parentThreadId: string;
  fallbackSubagents?: readonly WorkbenchSubagentSummary[];
  signal: AbortSignal;
}): Promise<WorkbenchSubagentPage> {
  const search = new URLSearchParams({ cwd, limit: String(limit), parentThreadId });
  if (cursor?.trim()) search.set("cursor", cursor.trim());
  const response = await fetch(`/api/subagents?${search.toString()}`, { cache: "no-store", signal });
  const payload = await response.json() as Omit<Partial<WorkbenchSubagentPage>, "subagents"> & {
    error?: string;
    subagents?: CompatibleWorkbenchSubagentSummary[];
  };
  if (!response.ok) throw new Error(payload.error || "Unable to read Workbench subagents.");
  return {
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    subagents: normalizeWorkbenchSubagentSummaries(payload.subagents ?? [], fallbackSubagents),
  };
}

function activityRank(status: WorkbenchSubagentSummary["activityStatus"]) {
  return status === "active" ? 0 : status === "unknown" ? 1 : 2;
}

export function sortWorkbenchSubagents(subagents: readonly WorkbenchSubagentSummary[]) {
  return subagents.slice().sort((left, right) => (
    activityRank(left.activityStatus) - activityRank(right.activityStatus)
    || right.lastActivityAt - left.lastActivityAt
    || right.createdAt - left.createdAt
    || left.threadId.localeCompare(right.threadId)
  ));
}

export function getSubagentTabLayout(
  subagents: readonly WorkbenchSubagentSummary[],
  {
    now = Date.now(),
    pinnedThreadIds = [],
    revealedThreadIds = new Set<string>(),
  }: {
    now?: number;
    pinnedThreadIds?: readonly string[];
    revealedThreadIds?: ReadonlySet<string>;
  } = {},
) {
  const visible: WorkbenchSubagentSummary[] = [];
  const collapsed: WorkbenchSubagentSummary[] = [];
  const sortedSubagentsByThreadId = new Map(
    sortWorkbenchSubagents(subagents).map((subagent) => [subagent.threadId, subagent]),
  );
  for (const threadId of pinnedThreadIds) {
    const subagent = sortedSubagentsByThreadId.get(threadId);
    if (!subagent) continue;
    visible.push(subagent);
    sortedSubagentsByThreadId.delete(threadId);
  }
  for (const subagent of sortedSubagentsByThreadId.values()) {
    const isStale = subagent.activityStatus !== "active"
      && subagent.lastActivityAt < now - SUBAGENT_STALE_AFTER_MS;
    (isStale && !revealedThreadIds.has(subagent.threadId) ? collapsed : visible).push(subagent);
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

export function getSubagentPollingBatch(threadIds: readonly string[], cursor: number) {
  if (!threadIds.length) return { nextCursor: 0, threadIds: [] as string[] };
  const start = ((cursor % threadIds.length) + threadIds.length) % threadIds.length;
  const count = Math.min(SUBAGENT_BACKGROUND_BATCH_SIZE, threadIds.length);
  const batch = Array.from({ length: count }, (_, index) => threadIds[(start + index) % threadIds.length]!);
  return {
    nextCursor: (start + count) % threadIds.length,
    threadIds: batch,
  };
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
) {
  const startingHue = hashThreadId(subagent.parentThreadId) % 360;
  const hue = (startingHue + SUBAGENT_HUE_ROTATION_DEGREES * subagent.directSubagentIndex) % 360;
  return `oklch(var(--oklch-text-lightness) 90% ${hue}deg)`;
}

export function getThreadAgentTabLabel(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  subagent?: WorkbenchSubagentSummary | null,
) {
  return getThreadAgentLabelParts(thread, subagent).text;
}
