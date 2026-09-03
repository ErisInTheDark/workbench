/*
 * Exports:
 * - WorkbenchThreadDisplayOrderSchema/WorkbenchThreadDisplayOrder/WorkbenchThreadFolder: strict project-level user layout with one-level folders. Keywords: thread, folder, display, ordering, schema.
 * - getWorkbenchThreadDisplayKey/getWorkbenchThreadDisplaySection/getWorkbenchThreadFolderKey: stable row, section, and folder identity. Keywords: thread, folder, pinned, snoozed, settled.
 * - normalizeWorkbenchThreadDisplayOrder/sortThreadSidebarEntries/resolveWorkbenchThreadDisplayOrder: decode legacy state and resolve layered automatic plus user order. Keywords: fallback, claims, lifecycle, user order.
 * - reconcileWorkbenchThreadDisplayOrder/createWorkbenchThreadFolder/renameWorkbenchThreadFolder/moveWorkbenchThreadDisplayItem/replaceWorkbenchThreadFolderMember: validate, prune, create, rename, move, and materialize layout state. Keywords: folder, draft, drag, persistence, section.
 * - projectWorkbenchThreadDisplaySection/findWorkbenchThreadFolder: project mixed root items and folder membership for rendering. Keywords: sidebar, disclosure, projection.
 * - isWorkbenchThreadDisplayOrderEmpty: identify layouts that do not need persistence. Keywords: storage, empty.
 */

import type { WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import {
  createThreadDisplayFolder,
  findThreadDisplayFolder,
  getThreadDisplayFolderKey,
  isThreadDisplayLayoutEmpty,
  moveThreadDisplayLayoutItem,
  normalizeThreadDisplayLayout,
  projectThreadDisplayLayoutSection,
  reconcileThreadDisplayLayout,
  renameThreadDisplayFolder,
  replaceThreadDisplayFolderMember,
  ThreadDisplayLayoutSchema,
  type ThreadDisplayFolder,
  type ThreadDisplayLayout,
  type ThreadDisplayLayoutEntry,
} from "./thread-display-layout.ts";

export const WORKBENCH_THREAD_DISPLAY_SECTIONS = ["pinned", "snoozed", "settled"] as const;
export type WorkbenchThreadDisplaySection = typeof WORKBENCH_THREAD_DISPLAY_SECTIONS[number];

enum ThreadSettleSort {
  Unsettled,
  Settled,
}

enum ThreadPrioritySort {
  Pinned,
  Normal,
  Snoozed,
}

enum ThreadClaimSort {
  HoldingClaims,
  NoClaims,
}

enum ThreadLifecycleSort {
  Draft,
  NeedsAttention,
  Working,
  Complete,
}

export const WorkbenchThreadDisplayOrderSchema = ThreadDisplayLayoutSchema;
export type WorkbenchThreadDisplayOrder = ThreadDisplayLayout;
export type WorkbenchThreadFolder = ThreadDisplayFolder;

export type WorkbenchThreadDisplayItem =
  | { entry: WorkbenchThreadSidebarEntry; itemKind: "thread" }
  | { entries: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>[]; folder: WorkbenchThreadFolder; itemKind: "folder" };

export function getWorkbenchThreadDisplayKey(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind === "draft"
    ? `draft:${entry.draft.draftId}`
    : `${entry.identity.harness}:${entry.identity.threadId}`;
}

export function getWorkbenchThreadFolderKey(folderId: string) {
  return getThreadDisplayFolderKey(folderId);
}

export function getWorkbenchThreadDisplaySection(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadDisplaySection | null {
  if (entry.entryKind === "subagent") return null;
  if (entry.metadata.archived) return null;
  if (entry.entryKind !== "draft" && entry.lifecycle.settled) return "settled";
  if (entry.metadata.snoozed) return "snoozed";
  return entry.metadata.pinned ? "pinned" : null;
}

export function normalizeWorkbenchThreadDisplayOrder(candidate: unknown): WorkbenchThreadDisplayOrder {
  return normalizeThreadDisplayLayout(candidate);
}

function threadSettleSort(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind !== "draft" && entry.lifecycle.settled
    ? ThreadSettleSort.Settled
    : ThreadSettleSort.Unsettled;
}

function threadPrioritySort(entry: WorkbenchThreadSidebarEntry) {
  const snoozed = entry.entryKind !== "subagent" && entry.metadata.snoozed;
  if (snoozed) return ThreadPrioritySort.Snoozed;
  const pinned = entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  return pinned ? ThreadPrioritySort.Pinned : ThreadPrioritySort.Normal;
}

function threadClaimSort(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind !== "draft" && Boolean(entry.gitArc?.claimedPaths.length)
    ? ThreadClaimSort.HoldingClaims
    : ThreadClaimSort.NoClaims;
}

function threadLifecycleSort(entry: WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return ThreadLifecycleSort.Draft;
  if (entry.lifecycle.kind === "needsAttention") return ThreadLifecycleSort.NeedsAttention;
  if (entry.lifecycle.kind === "working") return ThreadLifecycleSort.Working;
  return ThreadLifecycleSort.Complete;
}

function threadTurnStartSort(entry: WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return entry.draft.createdAt;
  if (entry.entryKind === "thread") return entry.orderAt ?? entry.activityAt;
  return entry.createdAt;
}

function compareThreadIdentity(left: WorkbenchThreadSidebarEntry, right: WorkbenchThreadSidebarEntry) {
  const leftHarness = left.entryKind === "draft" ? left.draft.harness : left.identity.harness;
  const rightHarness = right.entryKind === "draft" ? right.draft.harness : right.identity.harness;
  return leftHarness.localeCompare(rightHarness) || getWorkbenchThreadDisplayKey(left).localeCompare(getWorkbenchThreadDisplayKey(right));
}

function compareNaturalThreadOrder(left: WorkbenchThreadSidebarEntry, right: WorkbenchThreadSidebarEntry) {
  return (
    threadSettleSort(left) - threadSettleSort(right)
    || threadPrioritySort(left) - threadPrioritySort(right)
    || threadClaimSort(left) - threadClaimSort(right)
    || threadLifecycleSort(left) - threadLifecycleSort(right)
    || threadTurnStartSort(right) - threadTurnStartSort(left)
    || compareThreadIdentity(left, right)
  );
}

export function sortThreadSidebarEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return [...entries].sort(compareNaturalThreadOrder);
}

function projectLayoutEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  const projected = entries.flatMap((entry): Array<{ entry: WorkbenchThreadSidebarEntry; layout: ThreadDisplayLayoutEntry }> => {
    const section = getWorkbenchThreadDisplaySection(entry);
    return section ? [{ entry, layout: { key: getWorkbenchThreadDisplayKey(entry), section } }] : [];
  });
  return {
    entries: projected.map(({ entry }) => entry),
    layoutEntries: projected.map(({ layout }) => layout),
  };
}

export function reconcileWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
): WorkbenchThreadDisplayOrder {
  return reconcileThreadDisplayLayout(projectLayoutEntries(naturallyOrderedEntries).layoutEntries, candidate);
}

function resolveUserSortIndexes(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  order: WorkbenchThreadDisplayOrder,
) {
  const projected = projectLayoutEntries(naturallyOrderedEntries);
  return new Map(WORKBENCH_THREAD_DISPLAY_SECTIONS.flatMap((section) => {
    if (!Object.keys(order[section] ?? {}).length) return [];
    const items = projectThreadDisplayLayoutSection(projected.entries, projected.layoutEntries, order, section);
    const flattenedKeys = items.flatMap((item) => item.itemKind === "folder"
      ? item.entries.map(getWorkbenchThreadDisplayKey)
      : [getWorkbenchThreadDisplayKey(item.entry)]);
    return [[section, new Map(flattenedKeys.map((key, index) => [key, index]))] as const];
  }));
}

function compareThreadUserSort(
  left: WorkbenchThreadSidebarEntry,
  right: WorkbenchThreadSidebarEntry,
  indexesBySection: ReturnType<typeof resolveUserSortIndexes>,
) {
  const leftSection = getWorkbenchThreadDisplaySection(left);
  if (!leftSection || leftSection !== getWorkbenchThreadDisplaySection(right)) return 0;
  const indexes = indexesBySection.get(leftSection);
  if (!indexes) return 0;
  return indexes.get(getWorkbenchThreadDisplayKey(left))! - indexes.get(getWorkbenchThreadDisplayKey(right))!;
}

export function resolveWorkbenchThreadDisplayOrder(
  entries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
) {
  const naturallyOrderedEntries = sortThreadSidebarEntries(entries);
  const displayOrder = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const userSortIndexes = resolveUserSortIndexes(naturallyOrderedEntries, displayOrder);
  const orderedEntries = [...naturallyOrderedEntries].sort((left, right) => (
    threadSettleSort(left) - threadSettleSort(right)
    || compareThreadUserSort(left, right, userSortIndexes)
    || threadPrioritySort(left) - threadPrioritySort(right)
    || threadClaimSort(left) - threadClaimSort(right)
    || threadLifecycleSort(left) - threadLifecycleSort(right)
    || threadTurnStartSort(right) - threadTurnStartSort(left)
    || compareThreadIdentity(left, right)
  ));
  return { displayOrder, entries: orderedEntries };
}

export function findWorkbenchThreadFolder(candidate: unknown, threadKey: string) {
  return findThreadDisplayFolder(candidate, threadKey);
}

export function projectWorkbenchThreadDisplaySection(
  entries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
): WorkbenchThreadDisplayItem[] {
  const naturallyOrderedEntries = sortThreadSidebarEntries(entries);
  const projected = projectLayoutEntries(naturallyOrderedEntries);
  return projectThreadDisplayLayoutSection(
    projected.entries,
    projected.layoutEntries,
    candidate,
    section,
  ) as WorkbenchThreadDisplayItem[];
}

export function createWorkbenchThreadFolder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  folderId: string,
  sourceKey: string,
  title: string,
): WorkbenchThreadDisplayOrder | null {
  const entry = naturallyOrderedEntries.find((candidateEntry) => getWorkbenchThreadDisplayKey(candidateEntry) === sourceKey);
  if (entry?.entryKind !== "thread") return null;
  return createThreadDisplayFolder(projectLayoutEntries(naturallyOrderedEntries).layoutEntries, candidate, folderId, sourceKey, title);
}

export function renameWorkbenchThreadFolder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  folderId: string,
  title: string,
): WorkbenchThreadDisplayOrder | null {
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  return renameThreadDisplayFolder(order, folderId, title);
}

export function moveWorkbenchThreadDisplayItem(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
  sourceKey: string,
  destinationFolderId: string | null,
  beforeKey: string | null,
): WorkbenchThreadDisplayOrder | null {
  return moveThreadDisplayLayoutItem(
    projectLayoutEntries(naturallyOrderedEntries).layoutEntries,
    candidate,
    section,
    sourceKey,
    destinationFolderId,
    beforeKey,
  );
}

export function moveWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
  sourceKey: string,
  beforeKey: string | null,
): WorkbenchThreadDisplayOrder | null {
  return moveWorkbenchThreadDisplayItem(naturallyOrderedEntries, candidate, section, sourceKey, null, beforeKey);
}

export function replaceWorkbenchThreadFolderMember(candidate: unknown, sourceKey: string, replacementKey: string) {
  return replaceThreadDisplayFolderMember(candidate, sourceKey, replacementKey);
}

export function isWorkbenchThreadDisplayOrderEmpty(candidate: unknown) {
  return isThreadDisplayLayoutEmpty(candidate);
}
