/*
 * Exports:
 * - ThreadStateLayoutIdentityOwner: thread identity callback owned by the relational projector. Keywords: thread state, layout, identity.
 * - projectThreadStateLayout: project one project/global layout into typed items, augmentations, relations, and members. Keywords: thread state, layout, relational.
 */
import {
  parseProjectQualifiedThreadDisplayKey,
  type ThreadDisplayLayout,
  type ThreadDisplayLayoutSection,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  FOLDER_MEMBER_TABLE,
  FOLDER_TABLE,
  GLOBAL_LAYOUT_TABLE,
  LAYOUT_DRAFT_TABLE,
  LAYOUT_FOLDER_TABLE,
  LAYOUT_ITEM_TABLE,
  LAYOUT_RELATION_TABLE,
  LAYOUT_TABLE,
  LAYOUT_THREAD_TABLE,
  PROJECT_LAYOUT_TABLE,
  addRow,
  layoutItemId,
  type RowSets,
  type SqlRow,
} from "./workbench-thread-state-relational-tables.ts";

export type ThreadStateLayoutIdentityOwner = (
  projectId: string,
  harness: "codex" | "copilot" | "opencode",
  providerThreadId: string,
  defaults?: Partial<SqlRow>,
) => string;

function layoutThreadIdentity(key: string, projectId?: string) {
  const local = projectId ? { projectId, threadKey: key } : parseProjectQualifiedThreadDisplayKey(key);
  if (!local || local.threadKey.startsWith("draft:") || local.threadKey.startsWith("folder:")) return null;
  const separator = local.threadKey.indexOf(":");
  const harness = local.threadKey.slice(0, separator);
  const threadId = local.threadKey.slice(separator + 1);
  if (separator <= 0 || !threadId || (harness !== "codex" && harness !== "copilot" && harness !== "opencode")) return null;
  return { harness, projectId: local.projectId, threadId } as const;
}

export function projectThreadStateLayout(rows: RowSets, input: {
  displayOrder: ThreadDisplayLayout;
  ensureThread: ThreadStateLayoutIdentityOwner;
  layoutId: string;
  ownerKind: "project" | "pinned" | "home";
  projectId?: string;
  revision: number;
}) {
  const { displayOrder, layoutId, ownerKind } = input;
  addRow(rows, LAYOUT_TABLE, { id: layoutId, owner_kind: ownerKind, revision: input.revision });
  if (ownerKind === "project") {
    addRow(rows, PROJECT_LAYOUT_TABLE, { layout_id: layoutId, owner_kind: "project", project_id: input.projectId! });
  } else {
    addRow(rows, GLOBAL_LAYOUT_TABLE, { layout_id: layoutId, owner_kind: ownerKind });
  }
  const folders = ownerKind === "home" ? [] : displayOrder.folders ?? [];
  const folderByKey = new Map(folders.map((folder) => [`folder:${folder.folderId}`, folder]));
  const itemSections = new Map<string, ThreadDisplayLayoutSection>();
  for (const folder of folders) {
    itemSections.set(`folder:${folder.folderId}`, folder.section);
    for (const key of folder.threadKeys) itemSections.set(key, folder.section);
  }
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    for (const [key, position] of Object.entries(displayOrder[section] ?? {})) {
      itemSections.set(key, section);
      for (const related of [...position.above, ...position.below]) itemSections.set(related, section);
    }
  }
  const items = new Map<string, { id: string; kind: "thread" | "draft" | "folder"; section: ThreadDisplayLayoutSection }>();
  const ensureItem = (key: string, section: ThreadDisplayLayoutSection) => {
    const existing = items.get(key);
    if (existing) {
      if (existing.section !== section) throw new Error("One layout item appeared in multiple sections.");
      return existing;
    }
    const kind: "thread" | "draft" | "folder" = key.startsWith("folder:")
      ? "folder"
      : layoutThreadIdentity(key, input.projectId) ? "thread" : "draft";
    const item = { id: layoutItemId(layoutId, key), kind, section };
    items.set(key, item);
    return item;
  };
  for (const [key, section] of itemSections) ensureItem(key, section);
  for (const [key, item] of items) {
    addRow(rows, LAYOUT_ITEM_TABLE, { id: item.id, layout_id: layoutId, section: item.section, item_kind: item.kind });
    if (item.kind === "folder") {
      const folder = folderByKey.get(key);
      if (!folder) throw new Error("Layout references a missing folder.");
      addRow(rows, FOLDER_TABLE, {
        folder_id: folder.folderId,
        layout_id: layoutId,
        layout_owner_kind: ownerKind,
        section: folder.section,
        title: folder.title,
      });
      addRow(rows, LAYOUT_FOLDER_TABLE, { item_id: item.id, item_kind: "folder", folder_id: folder.folderId });
      continue;
    }
    if (item.kind === "draft") {
      const local = ownerKind === "project" ? { projectId: input.projectId!, threadKey: key } : parseProjectQualifiedThreadDisplayKey(key);
      if (!local?.threadKey.startsWith("draft:")) throw new Error("Layout draft key is invalid.");
      addRow(rows, LAYOUT_DRAFT_TABLE, { item_id: item.id, item_kind: "draft", draft_id: local.threadKey.slice("draft:".length) });
      continue;
    }
    const identity = layoutThreadIdentity(key, input.projectId);
    if (!identity) throw new Error("Layout thread key is invalid.");
    const threadId = input.ensureThread(identity.projectId, identity.harness, identity.threadId);
    addRow(rows, LAYOUT_THREAD_TABLE, { item_id: item.id, item_kind: "thread", thread_id: threadId });
  }
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    for (const [key, position] of Object.entries(displayOrder[section] ?? {})) {
      const item = ensureItem(key, section);
      position.above.forEach((related, relationIndex) => addRow(rows, LAYOUT_RELATION_TABLE, {
        item_id: item.id,
        related_item_id: ensureItem(related, section).id,
        layout_id: layoutId,
        section,
        relation_kind: "above",
        relation_index: relationIndex,
      }));
      position.below.forEach((related, relationIndex) => addRow(rows, LAYOUT_RELATION_TABLE, {
        item_id: item.id,
        related_item_id: ensureItem(related, section).id,
        layout_id: layoutId,
        section,
        relation_kind: "below",
        relation_index: relationIndex,
      }));
    }
  }
  for (const folder of folders) {
    const folderItem = ensureItem(`folder:${folder.folderId}`, folder.section);
    folder.threadKeys.forEach((key, memberIndex) => {
      const member = ensureItem(key, folder.section);
      if (member.kind === "folder") throw new Error("Thread layout folders cannot contain folders.");
      addRow(rows, FOLDER_MEMBER_TABLE, {
        folder_item_id: folderItem.id,
        folder_item_kind: "folder",
        member_item_id: member.id,
        member_item_kind: member.kind,
        layout_id: layoutId,
        section: folder.section,
        member_index: memberIndex,
      });
    });
  }
}
