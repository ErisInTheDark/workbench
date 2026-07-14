/*
 * Exports:
 * - listWorkbenchSubagents/readWorkbenchSubagentPage: fetch durable project metadata or one bounded parent page without joining thread hydration. Keywords: workbench, thread, subagent, metadata, fetch, pagination.
 * - getSubagentThreadIds/getSubagentSummary/getSubagentHarness/filterSubagentsByParentThreadId/filterSubagentThreadSummaries: derive and filter direct-child identity from durable summaries. Keywords: workbench, thread, subagent, metadata, harness, sidebar.
 * - sortWorkbenchSubagents/getSubagentTabLayout/getNextSubagentHydrationBatch/getSubagentPollingBatch: derive activity order, stale folding, and bounded background work. Keywords: subagent, tabs, activity, hydration, polling, batch.
 * - getThreadAgentAccentColor/getThreadAgentLabelParts/getThreadAgentTabLabel: stable child colors and metadata-first labels. Keywords: subagent, color, label, tabs.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchSubagentPage, WorkbenchSubagentSummary } from "../../types";

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;

const THREAD_AGENT_ACCENT_PALETTE = [
  0, 30, 60, 120, 150, 180, 210, 240, 270, 300, 330,
].map((hue) => `oklch(var(--oklch-text-lightness) 100% ${hue}deg)`);
const SUBAGENT_STALE_AFTER_MS = 30 * 60_000;
const SUBAGENT_BACKGROUND_BATCH_SIZE = 4;

function normalizeLabel(value: string | null | undefined) {
  return value?.trim() || null;
}

function hashLabel(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash) + character.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
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
  const payload = await response.json() as { error?: string; subagents?: WorkbenchSubagentSummary[] };
  if (!response.ok) throw new Error(payload.error || "Unable to read Workbench subagents.");
  return payload.subagents ?? [];
}

export async function readWorkbenchSubagentPage({
  cursor,
  cwd,
  limit = 20,
  parentThreadId,
  signal,
}: {
  cursor?: string | null;
  cwd: string;
  limit?: number;
  parentThreadId: string;
  signal: AbortSignal;
}): Promise<WorkbenchSubagentPage> {
  const search = new URLSearchParams({ cwd, limit: String(limit), parentThreadId });
  if (cursor?.trim()) search.set("cursor", cursor.trim());
  const response = await fetch(`/api/subagents?${search.toString()}`, { cache: "no-store", signal });
  const payload = await response.json() as Partial<WorkbenchSubagentPage> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Unable to read Workbench subagents.");
  return {
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    subagents: payload.subagents ?? [],
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
    revealedThreadIds = new Set<string>(),
  }: {
    now?: number;
    revealedThreadIds?: ReadonlySet<string>;
  } = {},
) {
  const visible: WorkbenchSubagentSummary[] = [];
  const collapsed: WorkbenchSubagentSummary[] = [];
  for (const subagent of sortWorkbenchSubagents(subagents)) {
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
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  fallbackKey = "",
  subagent?: WorkbenchSubagentSummary | null,
) {
  const label = normalizeLabel(subagent?.name)
    ?? normalizeLabel(fallbackKey)
    ?? normalizeLabel(thread?.agentNickname)
    ?? normalizeLabel(thread?.agentRole)
    ?? "subagent";
  return THREAD_AGENT_ACCENT_PALETTE[hashLabel(label) % THREAD_AGENT_ACCENT_PALETTE.length]
    ?? THREAD_AGENT_ACCENT_PALETTE[0];
}

export function getThreadAgentTabLabel(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  subagent?: WorkbenchSubagentSummary | null,
) {
  return getThreadAgentLabelParts(thread, subagent).text;
}
