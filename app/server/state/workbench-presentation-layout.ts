/*
 * Exports:
 * - createPresentationLayoutMutation: build authoritative scoped layout writes while retaining unobserved members.
 * - editPresentationProjectOrder/editPresentationPinnedOrder: apply semantic moves, drops and renames to current facts.
 * - editPresentationHomeOrder: prepare home ordering and project-folder membership from authoritative facts.
 */
import { randomUUID } from "node:crypto";
import type { PresentationMutation, PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchControls, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import {
  createWorkbenchThreadFolder, findWorkbenchThreadFolder, getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection,
  moveWorkbenchThreadDisplayItem, projectWorkbenchThreadDisplaySection, renameWorkbenchThreadFolder,
  type WorkbenchThreadDisplayOrder,
} from "workbench-shared/workbench/thread/thread-display-order";
import {
  createThreadDisplayFolder, getProjectQualifiedThreadDisplayKey, moveThreadDisplayLayoutItem,
  projectThreadDisplayLayoutSection, renameThreadDisplayFolder,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchHomeFolderKey, getWorkbenchHomeThreadKey, moveWorkbenchHomeThreadDisplayItem,
  projectWorkbenchHomeThreadList, resolveWorkbenchHomeThreadSectionKeys, type WorkbenchHomeThreadDisplayOrder,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { getThreadSidebarGroup } from "workbench-shared/workbench/thread/thread-state";
import { projectLogicalHomeDisplayOrder, projectLogicalPinnedDisplayOrder, projectLogicalThreadDisplayOrder } from "workbench-shared/workbench/project/workbench-project-projection";
import type { WorkspaceHomeLayoutIntent } from "workbench-shared/workbench/workspace/workspace-commands";

type Layout = Extract<PresentationMutation, { kind: "saveLayout" }>;
type LayoutSelection =
  | { scope: "project"; logicalProjectId: LogicalProjectId; order: WorkbenchThreadDisplayOrder }
  | { scope: "pinned"; logicalProjectId: null; order: WorkbenchThreadDisplayOrder }
  | { scope: "home"; logicalProjectId: null; order: WorkbenchHomeThreadDisplayOrder };

function rowIdentity(row: WorkbenchLogicalThreadRow) {
  return row.entry.entryKind === "draft" ? `draft:${row.entry.draft.draftId}`
    : `thread:${row.location.daemonId}/${row.location.projectId}/${row.entry.identity.threadId}`;
}

function memberIdentity(member: Layout["members"][number]) {
  return member.kind === "draft" ? `draft:${member.draftId}`
    : `thread:${member.thread?.location.daemonId}/${member.thread?.location.projectId}/${member.thread?.threadId}`;
}

function retainUnobserved<Value>(
  previous: readonly Value[], updated: readonly Value[], isObserved: (value: Value) => boolean,
): Value[] {
  const remaining = [...updated];
  const result: Value[] = [];
  for (const prior of previous) {
    if (!isObserved(prior)) result.push(prior);
    else if (remaining.length) result.push(remaining.shift()!);
  }
  return [...result, ...remaining];
}

export function createPresentationLayoutMutation(
  snapshot: PresentationSnapshot,
  rows: readonly WorkbenchLogicalThreadRow[],
  selection: LayoutSelection,
): Layout {
  const scoped = selection.scope === "project" ? rows.filter(row => row.logicalProjectId === selection.logicalProjectId) : rows;
  const previousMembers = snapshot.members.filter(member =>
    member.scope === selection.scope && member.logicalProjectId === selection.logicalProjectId)
    .sort((left, right) => left.position - right.position);
  const previousFolders = snapshot.folders.filter(folder =>
    folder.scope === selection.scope && folder.logicalProjectId === selection.logicalProjectId)
    .sort((left, right) => left.position - right.position);
  const previousByKey = new Map(previousMembers.map(member => [memberIdentity(member), member]));
  const folders: Layout["folders"] = [];
  const members: Layout["members"] = [];
  const add = (row: WorkbenchLogicalThreadRow, folderId: string | null) => {
    members.push({
      id: previousByKey.get(rowIdentity(row))?.id ?? randomUUID(),
      scope: selection.scope, logicalProjectId: selection.logicalProjectId, folderId,
      position: members.length, kind: row.entry.entryKind === "draft" ? "draft" : "thread",
      draftId: row.entry.entryKind === "draft" ? row.entry.draft.draftId : null,
      thread: row.entry.entryKind === "draft" ? null : { location: row.location, threadId: row.entry.identity.threadId },
    });
  };
  if (selection.scope === "home") {
    const entries = scoped.flatMap(row => {
      const section = getWorkbenchThreadDisplaySection(row.entry);
      return section ? [{ key: getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry), section, row }] : [];
    });
    const byKey = new Map(entries.map(entry => [entry.key, entry.row]));
    for (const section of ["pinned", "snoozed", "settled"] as const) {
      for (const key of resolveWorkbenchHomeThreadSectionKeys(entries, selection.order, section)) {
        const row = byKey.get(key);
        if (!row) throw new Error("Home layout row is no longer available.");
        add(row, null);
      }
    }
  } else if (selection.scope === "project") {
    const byKey = new Map(scoped.map(row => [getWorkbenchThreadDisplayKey(row.entry), row]));
    for (const section of ["pinned", "snoozed", "settled"] as const) {
      for (const item of projectWorkbenchThreadDisplaySection(scoped.map(row => row.entry), selection.order, section)) {
        const folderId = item.itemKind === "folder" ? item.folder.folderId : null;
        if (item.itemKind === "folder") folders.push({
          id: item.folder.folderId, scope: "project", logicalProjectId: selection.logicalProjectId,
          title: item.folder.title, position: folders.length,
        });
        for (const entry of item.itemKind === "folder" ? item.entries : [item.entry]) {
          const row = byKey.get(getWorkbenchThreadDisplayKey(entry));
          if (!row) throw new Error("Project layout row is no longer available.");
          add(row, folderId);
        }
      }
    }
  } else {
    const pinned = scoped.filter(row => getThreadSidebarGroup(row.entry) === "pinned");
    const entries = pinned.map(row => ({
      key: getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)),
      section: "pinned" as const,
    }));
    const byKey = new Map(pinned.map(row => [
      getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)), row,
    ]));
    for (const item of projectThreadDisplayLayoutSection(entries, entries, selection.order, "pinned")) {
      const folderId = item.itemKind === "folder" ? item.folder.folderId : null;
      if (item.itemKind === "folder") folders.push({
        id: item.folder.folderId, scope: "pinned", logicalProjectId: null,
        title: item.folder.title, position: folders.length,
      });
      for (const entry of item.itemKind === "folder" ? item.entries : [item.entry]) {
        const row = byKey.get(entry.key);
        if (!row) throw new Error("Pinned layout row is no longer available.");
        add(row, folderId);
      }
    }
  }
  const observed = new Set(scoped.map(rowIdentity));
  const retainedMembers = retainUnobserved(previousMembers, members, member => observed.has(memberIdentity(member)));
  const hiddenFolderIds = new Set(retainedMembers.filter(member => !observed.has(memberIdentity(member))).map(member => member.folderId));
  const retainedFolders = retainUnobserved(previousFolders, folders, folder =>
    !hiddenFolderIds.has(folder.id) || folders.some(next => next.id === folder.id));
  return {
    kind: "saveLayout", scope: selection.scope, logicalProjectId: selection.logicalProjectId,
    expectedRevision: snapshot.revision,
    members: retainedMembers.map((member, position) => ({ ...member, position })),
    folders: retainedFolders.map((folder, position) => ({ ...folder, position })),
  };
}

export function editPresentationProjectOrder(
  snapshot: PresentationSnapshot, logicalProjectId: LogicalProjectId, rows: readonly WorkbenchLogicalThreadRow[],
  intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[2],
) {
  const scoped = rows.filter(row => row.logicalProjectId === logicalProjectId);
  const entries = scoped.map(row => row.entry);
  const current = projectLogicalThreadDisplayOrder(logicalProjectId, scoped, snapshot);
  if (intent.kind === "rename") return renameWorkbenchThreadFolder(entries, current, intent.folderId, intent.title);
  if (intent.kind === "move") return moveWorkbenchThreadDisplayItem(
    entries, current, intent.section, intent.sourceKey, intent.destinationFolderId, intent.beforeKey);
  const folderId = intent.destinationFolderId ?? intent.folderId ?? randomUUID();
  const withFolder = intent.destinationFolderId ? current
    : createWorkbenchThreadFolder(entries, current, folderId, intent.targetKey, "New folder");
  return withFolder ? moveWorkbenchThreadDisplayItem(entries, withFolder, intent.section, intent.sourceKey, folderId, null) : null;
}

export function editPresentationPinnedOrder(
  snapshot: PresentationSnapshot, rows: readonly WorkbenchLogicalThreadRow[],
  intent: Parameters<WorkbenchControls["updatePresentationPinnedLayout"]>[1],
) {
  const entries = rows.filter(row => getThreadSidebarGroup(row.entry) === "pinned").map(row => ({
    key: getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)),
    section: "pinned" as const,
  }));
  const current = projectLogicalPinnedDisplayOrder(rows, snapshot);
  if (intent.kind === "rename") return renameThreadDisplayFolder(current, intent.folderId, intent.title);
  if (intent.kind === "move") return moveThreadDisplayLayoutItem(entries, current, "pinned", intent.sourceKey, intent.destinationFolderId, intent.beforeKey);
  const folderId = intent.destinationFolderId ?? intent.folderId ?? randomUUID();
  const withFolder = intent.destinationFolderId ? current : createThreadDisplayFolder(entries, current, folderId, intent.targetKey, "New folder");
  return withFolder ? moveThreadDisplayLayoutItem(entries, withFolder, "pinned", intent.sourceKey, folderId, null) : null;
}

export function editPresentationHomeOrder(
  snapshot: PresentationSnapshot, rows: readonly WorkbenchLogicalThreadRow[], intent: WorkspaceHomeLayoutIntent,
): LayoutSelection[] {
  const projectIds = [...new Set(rows.map(row => row.logicalProjectId))];
  const projectOrders = new Map(projectIds.map(id => [id, projectLogicalThreadDisplayOrder(id, rows, snapshot)]));
  const list = projectWorkbenchHomeThreadList({
    projects: projectIds.map(projectId => ({
      projectId, entries: rows.filter(row => row.logicalProjectId === projectId).map(row => row.entry),
      displayOrder: projectOrders.get(projectId),
    })),
  }, projectLogicalHomeDisplayOrder(rows, snapshot));
  const items = [...list.pinnedItems, ...list.snoozedItems, ...list.settledItems];
  const keyOf = (item: typeof items[number]) => item.itemKind === "folder"
    ? getWorkbenchHomeFolderKey(item.projectId, item.folder.folderId) : item.entry.threadKey;
  const source = items.find(item => keyOf(item) === intent.sourceKey);
  const sourceRow = rows.find(row => getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) === intent.sourceKey);
  if (!source && !sourceRow) throw new Error("The home layout source is no longer available.");
  if (source?.itemKind === "folder" && source.folder.section !== intent.section) {
    throw new Error("A folder cannot move between priority sections.");
  }
  const destination = intent.destinationFolderKey
    ? items.find(item => keyOf(item) === intent.destinationFolderKey) : null;
  if (intent.destinationFolderKey && destination?.itemKind !== "folder") {
    throw new Error("The destination folder is no longer available.");
  }
  if (destination?.itemKind === "folder" && (
    !sourceRow || sourceRow.logicalProjectId !== destination.projectId || destination.folder.section !== intent.section
  )) throw new Error("The destination folder belongs to another project or section.");

  const entries = rows.flatMap(row => {
    const section = getWorkbenchThreadDisplaySection(row.entry);
    return section ? [{ key: getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry), section }] : [];
  });
  const result: LayoutSelection[] = [];
  let beforeKey = intent.beforeKey;
  let withinSameFolder = false;
  if (sourceRow) {
    const projectOrder = projectOrders.get(sourceRow.logicalProjectId)!;
    const localKey = getWorkbenchThreadDisplayKey(sourceRow.entry);
    const sourceFolder = findWorkbenchThreadFolder(projectOrder, localKey);
    const destinationFolder = destination?.itemKind === "folder" ? destination.folder : null;
    const beforeRow = beforeKey ? rows.find(row =>
      getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) === beforeKey) : null;
    if (destinationFolder && beforeKey && (!beforeRow
      || beforeRow.logicalProjectId !== sourceRow.logicalProjectId
      || !destinationFolder.threadKeys.includes(getWorkbenchThreadDisplayKey(beforeRow.entry)))) {
      throw new Error("The requested position is outside the destination folder.");
    }
    if (sourceFolder || destinationFolder) {
      const order = moveWorkbenchThreadDisplayItem(
        rows.filter(row => row.logicalProjectId === sourceRow.logicalProjectId).map(row => row.entry),
        projectOrder, intent.section, localKey, destinationFolder?.folderId ?? null,
        beforeRow?.logicalProjectId === sourceRow.logicalProjectId ? getWorkbenchThreadDisplayKey(beforeRow.entry) : null,
      );
      if (!order) throw new Error("The project folder position is no longer available.");
      result.push({ scope: "project", logicalProjectId: sourceRow.logicalProjectId, order });
      withinSameFolder = Boolean(sourceFolder && sourceFolder.folderId === destinationFolder?.folderId);
    }
    if (destination?.itemKind === "folder" && !beforeKey) {
      const ordered = resolveWorkbenchHomeThreadSectionKeys(entries, list.displayOrder, intent.section);
      const members = new Set(destination.threadKeys);
      const last = ordered.reduce((index, key, candidate) => members.has(key) ? candidate : index, -1);
      const movedKeys = source?.threadKeys ?? [intent.sourceKey];
      beforeKey = ordered.slice(last + 1).find(key => !movedKeys.includes(key)) ?? null;
    }
  }
  if (!withinSameFolder) {
    const order = moveWorkbenchHomeThreadDisplayItem(entries, list.displayOrder, intent.section,
      source?.threadKeys ?? [intent.sourceKey], beforeKey);
    if (!order) throw new Error("The home position is no longer available.");
    result.push({ scope: "home", logicalProjectId: null, order });
  }
  return result;
}
