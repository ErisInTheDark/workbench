/*
 * Exports:
 * - WorkbenchHomeThreadDisplayOrder schema and types: define folder-free, project-qualified home priority order. Keywords: home, thread, order, project.
 * - projectWorkbenchHomeThreadList: combine project sidebars into one activity-ordered and user-ordered home projection with project-owned folders. Keywords: sidebar, folder, projection.
 * - move/replace/remove helpers: mutate home order by qualified thread blocks and keep project folder membership separate. Keywords: drag, persistence, folder, reconciliation.
 */

import {
  getProjectQualifiedThreadDisplayKey,
  getThreadDisplayFolderKey,
  normalizeThreadDisplayLayout,
  projectThreadDisplayLayoutSection,
  reconcileThreadDisplayLayout,
  removeThreadDisplayLayoutMember,
  type ThreadDisplayFolder,
  type ThreadDisplayLayoutEntry,
} from "./thread-display-layout";
import {
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  sortThreadSidebarEntries,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "./thread-display-order";
import {
  getThreadSidebarGroup,
  WorkbenchHomeThreadDisplayOrderSchema,
  type WorkbenchHomeThreadDisplayOrder,
  type WorkbenchProjectThreadSidebars,
  type WorkbenchThreadSidebarEntry,
} from "./thread-state";

export { WorkbenchHomeThreadDisplayOrderSchema };
export type { WorkbenchHomeThreadDisplayOrder };

export interface WorkbenchHomeThreadEntry {
  entry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>;
  projectId: string;
  threadKey: string;
}

export type WorkbenchHomeThreadDisplayItem =
  | { entry: WorkbenchHomeThreadEntry; itemKind: "thread"; threadKeys: [string] }
  | {
    entries: WorkbenchHomeThreadEntry[];
    folder: ThreadDisplayFolder;
    itemKind: "folder";
    projectId: string;
    threadKeys: string[];
  };

export interface WorkbenchHomeThreadList {
  displayOrder: WorkbenchHomeThreadDisplayOrder;
  mainEntries: WorkbenchHomeThreadEntry[];
  pinnedItems: WorkbenchHomeThreadDisplayItem[];
  settledItems: WorkbenchHomeThreadDisplayItem[];
  snoozedItems: WorkbenchHomeThreadDisplayItem[];
}

export function normalizeWorkbenchHomeThreadDisplayOrder(candidate: unknown): WorkbenchHomeThreadDisplayOrder {
  const parsed = WorkbenchHomeThreadDisplayOrderSchema.safeParse(candidate);
  if (!parsed.success) return {};
  const { folders: _folders, ...order } = normalizeThreadDisplayLayout(parsed.data);
  return order;
}

export function getWorkbenchHomeThreadKey(projectId: string, entry: WorkbenchThreadSidebarEntry) {
  return getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry));
}

export function getWorkbenchHomeFolderKey(projectId: string, folderId: string) {
  return getProjectQualifiedThreadDisplayKey(projectId, getThreadDisplayFolderKey(folderId));
}

function collectHomeEntries(sidebars: WorkbenchProjectThreadSidebars) {
  const naturallyOrdered = sortThreadSidebarEntries(sidebars.projects.flatMap((sidebar) => sidebar.entries));
  const entriesByIdentity = new Map(sidebars.projects.flatMap((sidebar) => sidebar.entries.map((entry) => [
    entry,
    {
      projectId: sidebar.projectId,
      threadKey: getWorkbenchHomeThreadKey(sidebar.projectId, entry),
    },
  ] as const)));
  return naturallyOrdered.flatMap((entry) => {
    const projected = entriesByIdentity.get(entry);
    if (!projected || entry.entryKind === "subagent" || getThreadSidebarGroup(entry) === "hidden") return [];
    return [{ ...projected, entry } satisfies WorkbenchHomeThreadEntry];
  });
}

function layoutEntries(entries: readonly WorkbenchHomeThreadEntry[]) {
  return entries.flatMap(({ entry, threadKey }): ThreadDisplayLayoutEntry[] => {
    const section = getWorkbenchThreadDisplaySection(entry);
    return section ? [{ key: threadKey, section }] : [];
  });
}

function folderLookup(sidebars: WorkbenchProjectThreadSidebars) {
  return new Map(sidebars.projects.flatMap((sidebar) => (sidebar.displayOrder?.folders ?? []).map((folder) => [
    getWorkbenchHomeFolderKey(sidebar.projectId, folder.folderId),
    { folder, projectId: sidebar.projectId, sidebar },
  ] as const)));
}

function collapseProjectFolders(
  orderedEntries: readonly WorkbenchHomeThreadEntry[],
  sidebars: WorkbenchProjectThreadSidebars,
): WorkbenchHomeThreadDisplayItem[] {
  const folders = folderLookup(sidebars);
  const folderByMember = new Map<string, ReturnType<typeof folders.get>>();
  for (const value of folders.values()) {
    for (const localThreadKey of value!.folder.threadKeys) {
      folderByMember.set(getProjectQualifiedThreadDisplayKey(value!.projectId, localThreadKey), value);
    }
  }
  const entriesByKey = new Map(orderedEntries.map((entry) => [entry.threadKey, entry]));
  const emittedFolders = new Set<string>();
  return orderedEntries.flatMap((entry): WorkbenchHomeThreadDisplayItem[] => {
    const owner = folderByMember.get(entry.threadKey);
    if (!owner) return [{ entry, itemKind: "thread", threadKeys: [entry.threadKey] }];
    const folderKey = getWorkbenchHomeFolderKey(owner.projectId, owner.folder.folderId);
    if (emittedFolders.has(folderKey)) return [];
    emittedFolders.add(folderKey);
    const entries = owner.folder.threadKeys.flatMap((localThreadKey) => {
      const member = entriesByKey.get(getProjectQualifiedThreadDisplayKey(owner.projectId, localThreadKey));
      return member ? [member] : [];
    });
    return entries.length ? [{
      entries,
      folder: owner.folder,
      itemKind: "folder",
      projectId: owner.projectId,
      threadKeys: entries.map(({ threadKey }) => threadKey),
    }] : [];
  });
}

function projectSection(
  entries: readonly WorkbenchHomeThreadEntry[],
  sidebars: WorkbenchProjectThreadSidebars,
  displayOrder: WorkbenchHomeThreadDisplayOrder,
  section: WorkbenchThreadDisplaySection,
) {
  const projected = entries.filter(({ entry }) => getWorkbenchThreadDisplaySection(entry) === section);
  const ordered = projectThreadDisplayLayoutSection(
    projected,
    layoutEntries(projected),
    displayOrder,
    section,
    { preserveMissing: true },
  ).flatMap((item) => item.itemKind === "thread" ? [item.entry] : item.entries);
  return collapseProjectFolders(ordered, sidebars);
}

export function projectWorkbenchHomeThreadList(
  sidebars: WorkbenchProjectThreadSidebars,
  candidate: unknown,
): WorkbenchHomeThreadList {
  const entries = collectHomeEntries(sidebars);
  const displayOrder = normalizeWorkbenchHomeThreadDisplayOrder(
    reconcileThreadDisplayLayout(layoutEntries(entries), candidate, { preserveMissing: true }),
  );
  return {
    displayOrder,
    mainEntries: entries.filter(({ entry }) => getThreadSidebarGroup(entry) === "main"),
    pinnedItems: projectSection(entries, sidebars, displayOrder, "pinned"),
    settledItems: projectSection(entries, sidebars, displayOrder, "settled"),
    snoozedItems: projectSection(entries, sidebars, displayOrder, "snoozed"),
  };
}

function orderedSectionKeys(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
) {
  return projectThreadDisplayLayoutSection(
    entries,
    entries,
    candidate,
    section,
    { preserveMissing: true },
  ).flatMap((item) => item.itemKind === "thread" ? [item.entry.key] : item.entries.map(({ key }) => key));
}

export function resolveWorkbenchHomeThreadSectionKeys(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
) {
  return orderedSectionKeys(entries, candidate, section);
}

function snapshotSectionKeys(keys: readonly string[], positionedKeys: ReadonlySet<string>) {
  return Object.fromEntries(keys.flatMap((key, index) => positionedKeys.has(key) ? [[key, {
    above: keys.slice(0, index),
    below: keys.slice(index + 1),
  }]] : []));
}

export function moveWorkbenchHomeThreadDisplayItem(
  entries: readonly ThreadDisplayLayoutEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
  sourceKeys: readonly string[],
  beforeKey: string | null,
): WorkbenchHomeThreadDisplayOrder | null {
  const uniqueSourceKeys = [...new Set(sourceKeys)];
  if (!uniqueSourceKeys.length || (beforeKey && uniqueSourceKeys.includes(beforeKey))) return null;
  const entrySections = new Map(entries.map((entry) => [entry.key, entry.section]));
  if (uniqueSourceKeys.some((key) => entrySections.get(key) !== section)) return null;
  if (beforeKey && entrySections.get(beforeKey) !== section) return null;
  const current = orderedSectionKeys(entries, candidate, section);
  const sourceSet = new Set(uniqueSourceKeys);
  if (uniqueSourceKeys.some((key) => !current.includes(key))) return null;
  const remaining = current.filter((key) => !sourceSet.has(key));
  const insertionIndex = beforeKey === null ? remaining.length : remaining.indexOf(beforeKey);
  if (insertionIndex < 0) return null;
  remaining.splice(insertionIndex, 0, ...uniqueSourceKeys);
  const normalized = normalizeWorkbenchHomeThreadDisplayOrder(candidate);
  const positionedKeys = new Set([
    ...Object.keys(normalized[section] ?? {}),
    ...uniqueSourceKeys,
  ]);
  return normalizeWorkbenchHomeThreadDisplayOrder({
    ...normalized,
    [section]: snapshotSectionKeys(remaining, positionedKeys),
  });
}

export function replaceWorkbenchHomeThreadDisplayMember(
  candidate: unknown,
  sourceKey: string,
  replacementKey: string,
): WorkbenchHomeThreadDisplayOrder {
  if (sourceKey === replacementKey) return normalizeWorkbenchHomeThreadDisplayOrder(candidate);
  const order = normalizeWorkbenchHomeThreadDisplayOrder(candidate);
  const replace = (key: string) => key === sourceKey ? replacementKey : key;
  return normalizeWorkbenchHomeThreadDisplayOrder(Object.fromEntries(Object.entries(order).map(([section, positions]) => [
    section,
    Object.fromEntries(Object.entries(positions ?? {}).map(([key, position]) => [
      replace(key),
      {
        above: position.above.map(replace),
        below: position.below.map(replace),
      },
    ])),
  ])));
}

export function removeWorkbenchHomeThreadDisplayMember(candidate: unknown, sourceKey: string) {
  return normalizeWorkbenchHomeThreadDisplayOrder(removeThreadDisplayLayoutMember(candidate, sourceKey));
}

export function removeWorkbenchThreadFromProjectFolder(
  candidate: unknown,
  sourceKey: string,
): WorkbenchThreadDisplayOrder {
  const order = normalizeThreadDisplayLayout(candidate);
  const folders = (order.folders ?? []).flatMap((folder) => {
    const threadKeys = folder.threadKeys.filter((key) => key !== sourceKey);
    return threadKeys.length ? [{ ...folder, threadKeys }] : [];
  });
  return { ...order, ...(folders.length ? { folders } : { folders: undefined }) };
}
