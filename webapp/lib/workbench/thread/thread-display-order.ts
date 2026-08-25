/*
 * Exports:
 * - WorkbenchThreadDisplayOrderSchema/WorkbenchThreadDisplayOrder/WorkbenchThreadFolder: strict project-level user layout with one-level folders. Keywords: thread, folder, display, ordering, schema.
 * - getWorkbenchThreadDisplayKey/getWorkbenchThreadDisplaySection/getWorkbenchThreadFolderKey: stable row, section, and folder identity. Keywords: thread, folder, pinned, snoozed, settled.
 * - normalizeWorkbenchThreadDisplayOrder/sortThreadSidebarEntries/resolveWorkbenchThreadDisplayOrder: decode legacy state and resolve layered automatic plus user order. Keywords: fallback, claims, lifecycle, user order.
 * - reconcileWorkbenchThreadDisplayOrder/createWorkbenchThreadFolder/renameWorkbenchThreadFolder/moveWorkbenchThreadDisplayItem/replaceWorkbenchThreadFolderMember: validate, prune, create, rename, move, and materialize layout state. Keywords: folder, draft, drag, persistence, section.
 * - projectWorkbenchThreadDisplaySection/findWorkbenchThreadFolder: project mixed root items and folder membership for rendering. Keywords: sidebar, disclosure, projection.
 * - isWorkbenchThreadDisplayOrderEmpty: identify layouts that do not need persistence. Keywords: storage, empty.
 */

import { z } from "zod";

import type { WorkbenchThreadSidebarEntry } from "./thread-state";

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

const WorkbenchThreadDisplayPositionSchema = z.object({
  above: z.array(z.string().min(1)),
  below: z.array(z.string().min(1)),
}).strict();

const WorkbenchThreadFolderSchema = z.object({
  folderId: z.uuid(),
  section: z.enum(WORKBENCH_THREAD_DISPLAY_SECTIONS),
  threadKeys: z.array(z.string().min(1)).min(1),
  title: z.string().trim().min(1).max(80),
}).strict();
export type WorkbenchThreadFolder = z.infer<typeof WorkbenchThreadFolderSchema>;

export const WorkbenchThreadDisplayOrderSchema = z.object({
  folders: z.array(WorkbenchThreadFolderSchema).optional(),
  pinned: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
  settled: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
  settledPinned: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
  snoozed: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
}).strict();
export type WorkbenchThreadDisplayOrder = z.infer<typeof WorkbenchThreadDisplayOrderSchema>;

export type WorkbenchThreadDisplayItem =
  | { entry: WorkbenchThreadSidebarEntry; itemKind: "thread" }
  | { entries: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>[]; folder: WorkbenchThreadFolder; itemKind: "folder" };

export function getWorkbenchThreadDisplayKey(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind === "draft"
    ? `draft:${entry.draft.draftId}`
    : `${entry.identity.harness}:${entry.identity.threadId}`;
}

export function getWorkbenchThreadFolderKey(folderId: string) {
  return `folder:${folderId}`;
}

export function getWorkbenchThreadDisplaySection(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadDisplaySection | null {
  if (entry.entryKind === "subagent") return null;
  if (entry.metadata.archived) return null;
  if (entry.entryKind !== "draft" && entry.lifecycle.settled) return "settled";
  if (entry.metadata.snoozed) return "snoozed";
  return entry.metadata.pinned ? "pinned" : null;
}

export function normalizeWorkbenchThreadDisplayOrder(candidate: unknown): WorkbenchThreadDisplayOrder {
  const parsed = WorkbenchThreadDisplayOrderSchema.safeParse(candidate);
  if (!parsed.success) return {};
  const { settledPinned, ...order } = parsed.data;
  const settled = { ...(settledPinned ?? {}), ...(order.settled ?? {}) };
  return {
    ...order,
    ...(Object.keys(settled).length ? { settled } : {}),
  };
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

function projectKeys(keys: readonly string[], positions: Record<string, { above: string[]; below: string[] }> | undefined) {
  if (!positions || !Object.keys(positions).length || keys.length < 2) return [...keys];
  const keySet = new Set(keys);
  const naturalIndex = new Map(keys.map((key, index) => [key, index]));
  const outgoing = new Map(keys.map((key) => [key, new Set<string>()]));
  const indegree = new Map(keys.map((key) => [key, 0]));
  const addEdge = (before: string, after: string) => {
    if (before === after || !keySet.has(before) || !keySet.has(after)) return;
    const targets = outgoing.get(before)!;
    if (targets.has(after)) return;
    targets.add(after);
    indegree.set(after, (indegree.get(after) ?? 0) + 1);
  };
  for (const [key, position] of Object.entries(positions)) {
    if (!keySet.has(key)) continue;
    for (const above of position.above) addEdge(above, key);
    for (const below of position.below) addEdge(key, below);
  }
  const ready = keys.filter((key) => indegree.get(key) === 0);
  const result: string[] = [];
  while (ready.length) {
    ready.sort((left, right) => naturalIndex.get(left)! - naturalIndex.get(right)!);
    const key = ready.shift()!;
    result.push(key);
    for (const target of outgoing.get(key) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return result.length === keys.length ? result : [...keys];
}

function snapshotKeys(projected: readonly string[], positionedKeys: ReadonlySet<string>) {
  return Object.fromEntries(projected.flatMap((key, index) => positionedKeys.has(key)
    ? [[key, { above: projected.slice(0, index), below: projected.slice(index + 1) }]]
    : []));
}

function folderMembership(folders: readonly WorkbenchThreadFolder[]) {
  return new Map(folders.flatMap((folder) => folder.threadKeys.map((key) => [key, folder] as const)));
}

function sectionItemKeys(
  entries: readonly WorkbenchThreadSidebarEntry[],
  folders: readonly WorkbenchThreadFolder[],
  section: WorkbenchThreadDisplaySection,
) {
  const membership = folderMembership(folders);
  const emittedFolders = new Set<string>();
  return entries.flatMap((entry) => {
    if (getWorkbenchThreadDisplaySection(entry) !== section) return [];
    const key = getWorkbenchThreadDisplayKey(entry);
    const folder = membership.get(key);
    if (!folder) return [key];
    if (emittedFolders.has(folder.folderId)) return [];
    emittedFolders.add(folder.folderId);
    return [getWorkbenchThreadFolderKey(folder.folderId)];
  });
}

export function reconcileWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
): WorkbenchThreadDisplayOrder {
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  const entriesByKey = new Map(naturallyOrderedEntries.map((entry) => [getWorkbenchThreadDisplayKey(entry), entry]));
  const usedThreadKeys = new Set<string>();
  const folders = (order.folders ?? []).flatMap((folder) => {
    const threadKeys = folder.threadKeys.filter((key) => {
      const entry = entriesByKey.get(key);
      if (usedThreadKeys.has(key) || !entry || entry.entryKind === "subagent" || getWorkbenchThreadDisplaySection(entry) !== folder.section) return false;
      usedThreadKeys.add(key);
      return true;
    });
    return threadKeys.length ? [{ ...folder, threadKeys }] : [];
  });
  const next: WorkbenchThreadDisplayOrder = { ...(folders.length ? { folders } : {}) };
  for (const section of WORKBENCH_THREAD_DISPLAY_SECTIONS) {
    const keys = sectionItemKeys(naturallyOrderedEntries, folders, section);
    const keySet = new Set(keys);
    const positioned = new Set(Object.keys(order[section] ?? {}).filter((key) => keySet.has(key)));
    const projected = projectKeys(keys, order[section]);
    const snapshot = snapshotKeys(projected, positioned);
    if (Object.keys(snapshot).length) next[section] = snapshot;
  }
  return next;
}

function resolveUserSortIndexes(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  order: WorkbenchThreadDisplayOrder,
) {
  const folders = order.folders ?? [];
  const entriesByKey = new Map(naturallyOrderedEntries.map((entry) => [getWorkbenchThreadDisplayKey(entry), entry]));
  return new Map(WORKBENCH_THREAD_DISPLAY_SECTIONS.flatMap((section) => {
    if (!Object.keys(order[section] ?? {}).length) return [];
    const rootKeys = projectKeys(sectionItemKeys(naturallyOrderedEntries, folders, section), order[section]);
    const flattenedKeys = rootKeys.flatMap((key) => {
      const folder = folders.find((candidate) => getWorkbenchThreadFolderKey(candidate.folderId) === key);
      return folder ? folder.threadKeys.filter((threadKey) => entriesByKey.has(threadKey)) : [key];
    });
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
  return normalizeWorkbenchThreadDisplayOrder(candidate).folders?.find((folder) => folder.threadKeys.includes(threadKey)) ?? null;
}

export function projectWorkbenchThreadDisplaySection(
  entries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
): WorkbenchThreadDisplayItem[] {
  const naturallyOrderedEntries = sortThreadSidebarEntries(entries);
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const folders = order.folders ?? [];
  const entriesByKey = new Map(entries.map((entry) => [getWorkbenchThreadDisplayKey(entry), entry]));
  const items: WorkbenchThreadDisplayItem[] = [];
  for (const key of projectKeys(sectionItemKeys(naturallyOrderedEntries, folders, section), order[section])) {
    const folder = folders.find((candidateFolder) => getWorkbenchThreadFolderKey(candidateFolder.folderId) === key);
    if (folder) {
      const folderEntries = folder.threadKeys.flatMap((threadKey) => {
        const entry = entriesByKey.get(threadKey);
        return entry && entry.entryKind !== "subagent" ? [entry] : [];
      });
      if (folderEntries.length) items.push({ entries: folderEntries, folder, itemKind: "folder" });
      continue;
    }
    const entry = entriesByKey.get(key);
    if (entry) items.push({ entry, itemKind: "thread" });
  }
  return items;
}

export function createWorkbenchThreadFolder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  folderId: string,
  sourceKey: string,
  title: string,
): WorkbenchThreadDisplayOrder | null {
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const entry = naturallyOrderedEntries.find((candidateEntry) => getWorkbenchThreadDisplayKey(candidateEntry) === sourceKey);
  const section = entry ? getWorkbenchThreadDisplaySection(entry) : null;
  if (entry?.entryKind !== "thread" || !section || findWorkbenchThreadFolder(order, sourceKey) || (order.folders ?? []).some((folder) => folder.folderId === folderId)) return null;
  const parsedFolder = WorkbenchThreadFolderSchema.safeParse({ folderId, section, threadKeys: [sourceKey], title });
  if (!parsedFolder.success) return null;
  const rootKeys = projectKeys(sectionItemKeys(naturallyOrderedEntries, order.folders ?? [], section), order[section]);
  const sourceIndex = rootKeys.indexOf(sourceKey);
  if (sourceIndex < 0) return null;
  rootKeys.splice(sourceIndex, 1, getWorkbenchThreadFolderKey(folderId));
  const positioned = new Set([
    ...Object.keys(order[section] ?? {}).filter((key) => key !== sourceKey),
    getWorkbenchThreadFolderKey(folderId),
  ]);
  return reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, {
    ...order,
    folders: [...(order.folders ?? []), parsedFolder.data],
    [section]: snapshotKeys(rootKeys, positioned),
  });
}

export function renameWorkbenchThreadFolder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  folderId: string,
  title: string,
): WorkbenchThreadDisplayOrder | null {
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const folder = order.folders?.find((candidateFolder) => candidateFolder.folderId === folderId);
  if (!folder) return null;
  const parsed = WorkbenchThreadFolderSchema.shape.title.safeParse(title);
  if (!parsed.success) return null;
  return {
    ...order,
    folders: order.folders!.map((candidateFolder) => candidateFolder.folderId === folderId ? { ...candidateFolder, title: parsed.data } : candidateFolder),
  };
}

export function moveWorkbenchThreadDisplayItem(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
  sourceKey: string,
  destinationFolderId: string | null,
  beforeKey: string | null,
): WorkbenchThreadDisplayOrder | null {
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const folders = [...(order.folders ?? [])];
  const sourceFolder = folders.find((folder) => folder.threadKeys.includes(sourceKey)) ?? null;
  const sourceFolderKey = sourceFolder ? getWorkbenchThreadFolderKey(sourceFolder.folderId) : null;
  const sourceFolderIndex = sourceFolder ? folders.indexOf(sourceFolder) : -1;
  const sourceEntry = naturallyOrderedEntries.find((entry) => getWorkbenchThreadDisplayKey(entry) === sourceKey) ?? null;
  const sourceRootFolder = folders.find((folder) => getWorkbenchThreadFolderKey(folder.folderId) === sourceKey) ?? null;
  if (sourceEntry && getWorkbenchThreadDisplaySection(sourceEntry) !== section) return null;
  if (sourceRootFolder && sourceRootFolder.section !== section) return null;
  if (!sourceEntry && !sourceRootFolder) return null;

  const destinationFolder = destinationFolderId ? folders.find((folder) => folder.folderId === destinationFolderId) ?? null : null;
  if (destinationFolderId && (!destinationFolder || destinationFolder.section !== section || !sourceEntry || sourceEntry.entryKind === "subagent")) return null;
  if (sourceRootFolder && destinationFolder) return null;

  if (sourceFolder && destinationFolder?.folderId === sourceFolder.folderId) {
    const keys = [...sourceFolder.threadKeys];
    if (beforeKey === sourceKey) return order;
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = beforeKey === null ? keys.length : keys.indexOf(beforeKey);
    if (sourceIndex < 0 || targetIndex < 0) return null;
    keys.splice(sourceIndex, 1);
    const insertionIndex = beforeKey === null ? keys.length : keys.indexOf(beforeKey);
    keys.splice(insertionIndex, 0, sourceKey);
    return { ...order, folders: folders.map((folder) => folder.folderId === sourceFolder.folderId ? { ...folder, threadKeys: keys } : folder) };
  }

  let rootKeys = projectKeys(sectionItemKeys(naturallyOrderedEntries, folders, section), order[section]);
  if (!sourceFolder) rootKeys = rootKeys.filter((key) => key !== sourceKey);
  if (sourceFolder) {
    const threadKeys = sourceFolder.threadKeys.filter((key) => key !== sourceKey);
    if (threadKeys.length) folders[sourceFolderIndex] = { ...sourceFolder, threadKeys };
    else {
      folders.splice(sourceFolderIndex, 1);
      rootKeys = rootKeys.filter((key) => key !== sourceFolderKey);
    }
  }

  if (destinationFolder) {
    const targetIndex = folders.findIndex((folder) => folder.folderId === destinationFolder.folderId);
    const threadKeys = [...folders[targetIndex]!.threadKeys];
    const insertionIndex = beforeKey === null ? threadKeys.length : threadKeys.indexOf(beforeKey);
    if (insertionIndex < 0) return null;
    threadKeys.splice(insertionIndex, 0, sourceKey);
    folders[targetIndex] = { ...folders[targetIndex]!, threadKeys };
  } else {
    if (beforeKey === sourceKey) return order;
    const insertionIndex = beforeKey === null ? rootKeys.length : rootKeys.indexOf(beforeKey);
    if (insertionIndex < 0) return null;
    rootKeys.splice(insertionIndex, 0, sourceKey);
  }

  const validRootKeys = new Set(rootKeys);
  const positioned = new Set([
    ...Object.keys(order[section] ?? {}).filter((key) => validRootKeys.has(key)),
    ...folders.filter((folder) => folder.section === section).map((folder) => getWorkbenchThreadFolderKey(folder.folderId)),
    ...(!destinationFolder ? [sourceKey] : []),
  ]);
  return reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, {
    ...order,
    ...(folders.length ? { folders } : { folders: undefined }),
    [section]: snapshotKeys(rootKeys, positioned),
  });
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
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  const sourceFolder = order.folders?.find((folder) => folder.threadKeys.includes(sourceKey));
  if (!sourceFolder || sourceKey === replacementKey || order.folders?.some((folder) => folder.threadKeys.includes(replacementKey))) return order;
  return {
    ...order,
    folders: order.folders!.map((folder) => folder.folderId === sourceFolder.folderId
      ? { ...folder, threadKeys: folder.threadKeys.map((key) => key === sourceKey ? replacementKey : key) }
      : folder),
  };
}

export function isWorkbenchThreadDisplayOrderEmpty(candidate: unknown) {
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  return !(order.folders?.length) && WORKBENCH_THREAD_DISPLAY_SECTIONS.every((section) => !Object.keys(order[section] ?? {}).length);
}
