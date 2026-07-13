/*
 * Exports:
 * - listWorkbenchSubagents: fetch durable project- or parent-scoped child summaries without joining thread hydration. Keywords: workbench, thread, subagent, metadata, fetch.
 * - getSubagentThreadIds/getSubagentSummary/getSubagentHarness/filterSubagentThreadSummaries: derive and filter direct-child identity from durable summaries. Keywords: workbench, thread, subagent, metadata, harness, sidebar.
 * - getThreadAgentAccentColor/getThreadAgentLabelParts/getThreadAgentTabLabel: stable child colors and metadata-first labels. Keywords: subagent, color, label, tabs.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchSubagentSummary } from "../../types";

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;

const THREAD_AGENT_ACCENT_PALETTE = [
  0, 30, 60, 120, 150, 180, 210, 240, 270, 300, 330,
].map((hue) => `oklch(var(--oklch-text-lightness) 100% ${hue}deg)`);

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
