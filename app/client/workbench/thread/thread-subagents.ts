/*
 * Keywords: thread, subagent, identity, harness, command, tabs, lifecycle, hydration, hue.
 * Exports:
 * - ThreadAgentLabelParts: nickname, role, and combined display label.
 * - WorkbenchSubagentCommandDisplayTarget: durable identity for a command selector.
 * - sortWorkbenchSubagents: order children by lifecycle, Lock, and activity.
 * - SubagentTabOrder/reconcileSubagentTabOrder: stable tab order that only promotes new or unsettled children.
 * - getSubagentTabLayout: partition visible and collapsed child tabs.
 * - getNextSubagentHydrationBatch: select bounded child-body hydration work.
 * - getSubagentThreadIds: derive direct-child thread IDs.
 * - mergeWorkbenchSubagentSummaries: merge pushed child metadata.
 * - reconcileWorkbenchSubagentPage: reconcile paged children with retained summaries.
 * - getSubagentSummary: find a child by thread ID.
 * - getWorkbenchSubagentCommandTargetKey: key an ID/name selector.
 * - resolveWorkbenchSubagentCommandTargets: resolve selectors without guessing reused names.
 * - getSubagentHarness: resolve a child's harness with a fallback.
 * - filterSubagentsByParentThreadId: select a parent's children.
 * - filterSubagentThreadSummaries: exclude child IDs from thread summaries.
 * - getThreadAgentLabelParts: resolve metadata-first labels.
 * - getThreadAgentAccentHue: derive a child's hue from parent identity and sibling index.
 * - getThreadAgentTabLabel: resolve combined tab label text.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchSubagentSummary } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { getIdentityAccentHue } from "../identity-accent-color";
import type { WorkbenchSubagentCommandTarget } from "./command-matchers/workbench-cli";

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

export interface WorkbenchSubagentCommandDisplayTarget {
  fallbackName: string | null;
  subagent: WorkbenchSubagentSummary | null;
  targetKey: string;
  threadId: string | null;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;
const SUBAGENT_HUE_ROTATION_DEGREES = 1080 / 23;
const SUBAGENT_BACKGROUND_BATCH_SIZE = 4;

function normalizeLabel(value: string | null | undefined) {
  return value?.trim() || null;
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

export interface SubagentTabOrder {
  order: readonly string[];
  settled: ReadonlySet<string>;
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Keep tab positions stable across activity: only first sightings and returns from settlement move to the front.
 * Returns `previous` itself when nothing moved, so callers can keep referential stability.
 */
export function reconcileSubagentTabOrder(
  previous: SubagentTabOrder | null,
  subagents: readonly WorkbenchSubagentSummary[],
): SubagentTabOrder {
  const settled = new Set<string>(subagents.filter((subagent) => subagent.lifecycle?.settled).map(({ threadId }) => threadId));
  const newestFirst = subagents.slice().sort((left, right) => right.createdAt - left.createdAt || left.threadId.localeCompare(right.threadId));
  if (!previous) return { order: newestFirst.map(({ threadId }) => threadId), settled };
  const known = new Set(previous.order);
  const promoted = newestFirst
    .filter(({ threadId }) => !known.has(threadId) || (previous.settled.has(threadId) && !settled.has(threadId)))
    .map(({ threadId }) => threadId);
  const promotedIds = new Set<string>(promoted);
  const present = new Set<string>(subagents.map(({ threadId }) => threadId));
  const order = [...promoted, ...previous.order.filter((threadId) => present.has(threadId) && !promotedIds.has(threadId))];
  return areDeeplyEqual(previous.order, order) && sameMembers(previous.settled, settled) ? previous : { order, settled };
}

export function getSubagentTabLayout(
  subagents: readonly WorkbenchSubagentSummary[],
  {
    order,
    revealedThreadIds = new Set<string>(),
  }: {
    /** Tab order from `reconcileSubagentTabOrder`; defaults to lifecycle ordering. */
    order?: readonly string[];
    revealedThreadIds?: ReadonlySet<string>;
  } = {},
) {
  const visible: WorkbenchSubagentSummary[] = [];
  const collapsed: WorkbenchSubagentSummary[] = [];
  const position = new Map(order?.map((threadId, index) => [threadId, index]));
  const ordered = order
    ? subagents.slice().sort((left, right) => (position.get(left.threadId) ?? -1) - (position.get(right.threadId) ?? -1))
    : sortWorkbenchSubagents(subagents);
  for (const subagent of ordered) {
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

export function getWorkbenchSubagentCommandTargetKey(target: WorkbenchSubagentCommandTarget) {
  return target.kind === "name"
    ? `name:${target.value.toLocaleLowerCase()}`
    : `id:${target.value}`;
}

export function resolveWorkbenchSubagentCommandTargets(
  subagents: readonly WorkbenchSubagentSummary[],
  targets: readonly WorkbenchSubagentCommandTarget[],
): WorkbenchSubagentCommandDisplayTarget[] {
  return targets.map((target) => {
    const matches = target.kind === "id"
      ? subagents.filter((subagent) => subagent.threadId === target.value)
      : subagents.filter((subagent) => subagent.name.localeCompare(target.value, undefined, { sensitivity: "accent" }) === 0);
    const subagent = matches.length === 1 ? matches[0]! : null;
    return {
      fallbackName: target.kind === "name" ? target.value : null,
      subagent,
      targetKey: getWorkbenchSubagentCommandTargetKey(target),
      threadId: subagent?.threadId ?? (target.kind === "id" ? target.value : null),
    };
  });
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

export function getThreadAgentAccentHue(
  subagent: Pick<WorkbenchSubagentSummary, "directSubagentIndex" | "parentThreadId">,
) {
  return getIdentityAccentHue(
    subagent.parentThreadId,
    SUBAGENT_HUE_ROTATION_DEGREES * subagent.directSubagentIndex,
  );
}

export function getThreadAgentTabLabel(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  subagent?: WorkbenchSubagentSummary | null,
) {
  return getThreadAgentLabelParts(thread, subagent).text;
}
