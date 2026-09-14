/*
 * Exports:
 * - ThreadDisplayLayout schemas and types: define key-based one-level folders and relative section order.
 * - getProjectQualifiedThreadDisplayKey/parseProjectQualifiedThreadDisplayKey: encode and decode collision-safe global members.
 * - getThreadDisplayThreadKey/getThreadDisplayDraftKey/getThreadDisplayFolderKey: construct local display keys from distinct entity IDs.
 * - normalize/reconcile/project/create/rename/move/replace/remove helpers: own reusable layout mechanics for project and global pinned adapters.
 */

import { z } from "zod";
import type { ProviderKey } from "../provider/provider-key.ts";
import {
  ProjectIdSchema, ProjectThreadDisplayKeySchema, ThreadDisplayKeySchema,
  type DraftId, type FolderId, type ProjectId, type ThreadDisplayKey, type WorkbenchThreadId,
} from "../identity.ts";

export const THREAD_DISPLAY_LAYOUT_SECTIONS = ["pinned", "snoozed", "settled"] as const;
export type ThreadDisplayLayoutSection = typeof THREAD_DISPLAY_LAYOUT_SECTIONS[number];

const ThreadDisplayPositionSchema = z.object({
  above: z.array(z.string().min(1)),
  below: z.array(z.string().min(1)),
}).strict();

export const ThreadDisplayFolderSchema = z.object({
  folderId: z.uuid().brand<"FolderId">(),
  section: z.enum(THREAD_DISPLAY_LAYOUT_SECTIONS),
  threadKeys: z.array(z.string().min(1)).min(1),
  title: z.string().trim().min(1).max(80),
}).strict();
export type ThreadDisplayFolder = z.infer<typeof ThreadDisplayFolderSchema>;

export const ThreadDisplayLayoutSchema = z.object({
  folders: z.array(ThreadDisplayFolderSchema).optional(),
  pinned: z.record(z.string().min(1), ThreadDisplayPositionSchema).optional(),
  settled: z.record(z.string().min(1), ThreadDisplayPositionSchema).optional(),
  settledPinned: z.record(z.string().min(1), ThreadDisplayPositionSchema).optional(),
  snoozed: z.record(z.string().min(1), ThreadDisplayPositionSchema).optional(),
}).strict();
export type ThreadDisplayLayout = z.infer<typeof ThreadDisplayLayoutSchema>;

export interface ThreadDisplayLayoutEntry<Key extends string = string> {
  key: Key;
  section: ThreadDisplayLayoutSection;
}

export type ThreadDisplayLayoutItem<T> =
  | { entry: T; itemKind: "thread" }
  | { entries: T[]; folder: ThreadDisplayFolder; itemKind: "folder" };

export function getThreadDisplayFolderKey(folderId: FolderId) {
  return ThreadDisplayKeySchema.parse(`folder:${folderId}`);
}

export function getThreadDisplayThreadKey(harness: ProviderKey, threadId: WorkbenchThreadId) {
  return ThreadDisplayKeySchema.parse(`${harness}:${threadId}`);
}

export function getThreadDisplayDraftKey(draftId: DraftId) {
  return ThreadDisplayKeySchema.parse(`draft:${draftId}`);
}

export function getProjectQualifiedThreadDisplayKey(projectId: ProjectId, threadKey: ThreadDisplayKey) {
  return ProjectThreadDisplayKeySchema.parse(`${encodeURIComponent(projectId)}/${encodeURIComponent(threadKey)}`);
}

export function parseProjectQualifiedThreadDisplayKey(key: string) {
  const separatorIndex = key.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) return null;
  try {
    const projectId = decodeURIComponent(key.slice(0, separatorIndex));
    const threadKey = decodeURIComponent(key.slice(separatorIndex + 1));
    return projectId && threadKey ? { projectId: ProjectIdSchema.parse(projectId), threadKey: ThreadDisplayKeySchema.parse(threadKey) } : null;
  } catch {
    return null;
  }
}

export function normalizeThreadDisplayLayout(candidate: unknown): ThreadDisplayLayout {
  const parsed = ThreadDisplayLayoutSchema.safeParse(candidate);
  if (!parsed.success) return {};
  const { settledPinned, ...order } = parsed.data;
  const settled = { ...(settledPinned ?? {}), ...(order.settled ?? {}) };
  return { ...order, ...(Object.keys(settled).length ? { settled } : {}) };
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

function folderMembership(folders: readonly ThreadDisplayFolder[]) {
  return new Map(folders.flatMap((folder) => folder.threadKeys.map((key) => [key, folder] as const)));
}

function sectionItemKeys(entries: readonly ThreadDisplayLayoutEntry[], folders: readonly ThreadDisplayFolder[], section: ThreadDisplayLayoutSection) {
  const membership = folderMembership(folders);
  const emittedFolders = new Set<string>();
  return entries.flatMap((entry) => {
    if (entry.section !== section) return [];
    const folder = membership.get(entry.key);
    if (!folder) return [entry.key];
    if (emittedFolders.has(folder.folderId)) return [];
    emittedFolders.add(folder.folderId);
    return [getThreadDisplayFolderKey(folder.folderId)];
  });
}

export function reconcileThreadDisplayLayout(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  options: { preserveMissing?: boolean } = {},
): ThreadDisplayLayout {
  const order = normalizeThreadDisplayLayout(candidate);
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const usedThreadKeys = new Set<string>();
  const folders = (order.folders ?? []).flatMap((folder) => {
    const threadKeys = folder.threadKeys.filter((key) => {
      const entry = entriesByKey.get(key);
      if (usedThreadKeys.has(key)) return false;
      if (!entry) {
        if (!options.preserveMissing) return false;
        usedThreadKeys.add(key);
        return true;
      }
      if (entry.section !== folder.section) return false;
      usedThreadKeys.add(key);
      return true;
    });
    return threadKeys.length ? [{ ...folder, threadKeys }] : [];
  });
  const next: ThreadDisplayLayout = { ...(folders.length ? { folders } : {}) };
  for (const section of THREAD_DISPLAY_LAYOUT_SECTIONS) {
    const keys = sectionItemKeys(entries, folders, section);
    const keySet = new Set(keys);
    const preserved = options.preserveMissing
      ? Object.fromEntries(Object.entries(order[section] ?? {}).filter(([key]) => !keySet.has(key)))
      : {};
    const positioned = new Set(Object.keys(order[section] ?? {}).filter((key) => keySet.has(key)));
    const snapshot = { ...preserved, ...snapshotKeys(projectKeys(keys, order[section]), positioned) };
    if (Object.keys(snapshot).length) next[section] = snapshot;
  }
  return next;
}

export function projectThreadDisplayLayoutSection<T>(
  entries: readonly T[],
  layoutEntries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  section: ThreadDisplayLayoutSection,
  options: { preserveMissing?: boolean } = {},
): ThreadDisplayLayoutItem<T>[] {
  const order = reconcileThreadDisplayLayout(layoutEntries, candidate, options);
  const folders = order.folders ?? [];
  const entriesByKey = new Map(layoutEntries.map((entry, index) => [entry.key, entries[index]!]));
  const items: ThreadDisplayLayoutItem<T>[] = [];
  for (const key of projectKeys(sectionItemKeys(layoutEntries, folders, section), order[section])) {
    const folder = folders.find((candidateFolder) => getThreadDisplayFolderKey(candidateFolder.folderId) === key);
    if (folder) {
      const folderEntries = folder.threadKeys.flatMap((threadKey) => {
        const entry = entriesByKey.get(threadKey);
        return entry ? [entry] : [];
      });
      if (folderEntries.length) items.push({ entries: folderEntries, folder, itemKind: "folder" });
      continue;
    }
    const entry = entriesByKey.get(key);
    if (entry) items.push({ entry, itemKind: "thread" });
  }
  return items;
}

export function createThreadDisplayFolder(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  folderId: string,
  sourceKey: string,
  title: string,
  options: { preserveMissing?: boolean } = {},
): ThreadDisplayLayout | null {
  const order = reconcileThreadDisplayLayout(entries, candidate, options);
  const entry = entries.find((candidateEntry) => candidateEntry.key === sourceKey);
  if (!entry || findThreadDisplayFolder(order, sourceKey) || (order.folders ?? []).some((folder) => folder.folderId === folderId)) return null;
  const parsedFolder = ThreadDisplayFolderSchema.safeParse({ folderId, section: entry.section, threadKeys: [sourceKey], title });
  if (!parsedFolder.success) return null;
  const rootKeys = projectKeys(sectionItemKeys(entries, order.folders ?? [], entry.section), order[entry.section]);
  const sourceIndex = rootKeys.indexOf(sourceKey);
  if (sourceIndex < 0) return null;
  rootKeys.splice(sourceIndex, 1, getThreadDisplayFolderKey(parsedFolder.data.folderId));
  const positioned = new Set([...Object.keys(order[entry.section] ?? {}).filter((key) => key !== sourceKey), getThreadDisplayFolderKey(parsedFolder.data.folderId)]);
  return reconcileThreadDisplayLayout(entries, {
    ...order,
    folders: [...(order.folders ?? []), parsedFolder.data],
    [entry.section]: snapshotKeys(rootKeys, positioned),
  }, options);
}

export function renameThreadDisplayFolder(candidate: unknown, folderId: string, title: string) {
  const order = normalizeThreadDisplayLayout(candidate);
  const folder = order.folders?.find((candidateFolder) => candidateFolder.folderId === folderId);
  const parsed = ThreadDisplayFolderSchema.shape.title.safeParse(title);
  if (!folder || !parsed.success) return null;
  return { ...order, folders: order.folders!.map((candidateFolder) => candidateFolder.folderId === folderId ? { ...candidateFolder, title: parsed.data } : candidateFolder) };
}

export function moveThreadDisplayLayoutItem(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  section: ThreadDisplayLayoutSection,
  sourceKey: string,
  destinationFolderId: string | null,
  beforeKey: string | null,
  options: { preserveMissing?: boolean } = {},
): ThreadDisplayLayout | null {
  const order = reconcileThreadDisplayLayout(entries, candidate, options);
  const folders = [...(order.folders ?? [])];
  const sourceFolder = folders.find((folder) => folder.threadKeys.includes(sourceKey)) ?? null;
  const sourceFolderKey = sourceFolder ? getThreadDisplayFolderKey(sourceFolder.folderId) : null;
  const sourceFolderIndex = sourceFolder ? folders.indexOf(sourceFolder) : -1;
  const sourceEntry = entries.find((entry) => entry.key === sourceKey) ?? null;
  const sourceRootFolder = folders.find((folder) => getThreadDisplayFolderKey(folder.folderId) === sourceKey) ?? null;
  if (sourceEntry && sourceEntry.section !== section) return null;
  if (sourceRootFolder && sourceRootFolder.section !== section) return null;
  if (!sourceEntry && !sourceRootFolder) return null;
  const destinationFolder = destinationFolderId ? folders.find((folder) => folder.folderId === destinationFolderId) ?? null : null;
  if (destinationFolderId && (!destinationFolder || destinationFolder.section !== section || !sourceEntry)) return null;
  if (sourceRootFolder && destinationFolder) return null;
  if (sourceFolder && destinationFolder?.folderId === sourceFolder.folderId) {
    const keys = [...sourceFolder.threadKeys];
    if (beforeKey === sourceKey) return order;
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = beforeKey === null ? keys.length : keys.indexOf(beforeKey);
    if (sourceIndex < 0 || targetIndex < 0) return null;
    keys.splice(sourceIndex, 1);
    keys.splice(beforeKey === null ? keys.length : keys.indexOf(beforeKey), 0, sourceKey);
    return { ...order, folders: folders.map((folder) => folder.folderId === sourceFolder.folderId ? { ...folder, threadKeys: keys } : folder) };
  }
  let rootKeys = projectKeys(sectionItemKeys(entries, folders, section), order[section]);
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
    ...folders.filter((folder) => folder.section === section).map((folder) => getThreadDisplayFolderKey(folder.folderId)),
    ...(!destinationFolder ? [sourceKey] : []),
  ]);
  return reconcileThreadDisplayLayout(entries, {
    ...order,
    ...(folders.length ? { folders } : { folders: undefined }),
    [section]: snapshotKeys(rootKeys, positioned),
  }, options);
}

export function findThreadDisplayFolder(candidate: unknown, threadKey: string) {
  return normalizeThreadDisplayLayout(candidate).folders?.find((folder) => folder.threadKeys.includes(threadKey)) ?? null;
}

export function replaceThreadDisplayFolderMember(candidate: unknown, sourceKey: string, replacementKey: string) {
  const order = normalizeThreadDisplayLayout(candidate);
  const sourceFolder = order.folders?.find((folder) => folder.threadKeys.includes(sourceKey));
  if (!sourceFolder || sourceKey === replacementKey || order.folders?.some((folder) => folder.threadKeys.includes(replacementKey))) return order;
  return { ...order, folders: order.folders!.map((folder) => folder.folderId === sourceFolder.folderId
    ? { ...folder, threadKeys: folder.threadKeys.map((key) => key === sourceKey ? replacementKey : key) }
    : folder) };
}

export function removeThreadDisplayLayoutMember(candidate: unknown, sourceKey: string) {
  const order = normalizeThreadDisplayLayout(candidate);
  const folders = (order.folders ?? []).flatMap((folder) => {
    const threadKeys = folder.threadKeys.filter((key) => key !== sourceKey);
    return threadKeys.length ? [{ ...folder, threadKeys }] : [];
  });
  const next: ThreadDisplayLayout = { ...order, ...(folders.length ? { folders } : { folders: undefined }) };
  for (const section of THREAD_DISPLAY_LAYOUT_SECTIONS) {
    if (!next[section]?.[sourceKey]) continue;
    const { [sourceKey]: _removed, ...positions } = next[section]!;
    next[section] = Object.keys(positions).length ? positions : undefined;
  }
  return next;
}

export function isThreadDisplayLayoutEmpty(candidate: unknown) {
  const order = normalizeThreadDisplayLayout(candidate);
  return !(order.folders?.length) && THREAD_DISPLAY_LAYOUT_SECTIONS.every((section) => !Object.keys(order[section] ?? {}).length);
}
