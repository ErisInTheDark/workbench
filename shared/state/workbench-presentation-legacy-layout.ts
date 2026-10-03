/*
 * Exports:
 * - projectLegacyPresentationLayout: map daemon project ordering into app-owned layout members.
 * - homeLegacyPresentationLayout: map daemon Home ordering into app-owned layout members.
 * - pinnedLegacyPresentationLayout: map daemon pinned ordering into app-owned layout members.
 */
import type { PresentationMutation, PresentationSnapshot } from "./workbench-presentation-state.ts";
import { ProjectIdSchema, type DaemonId, type LogicalProjectId, type ProjectId } from "../workbench/identity.ts";
import {
  getWorkbenchThreadDisplayKey, projectWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayOrder,
} from "../workbench/thread/thread-display-order.ts";
import {
  getProjectQualifiedThreadDisplayKey, projectThreadDisplayLayoutSection,
} from "../workbench/thread/thread-display-layout.ts";
import {
  getWorkbenchHomeThreadKey, projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayOrder,
} from "../workbench/thread/home-thread-display-order.ts";
import { getThreadSidebarGroup } from "../workbench/thread/thread-state.ts";
import type {
  WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars,
  WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot,
} from "../workbench/thread/thread-sidebar-row.ts";

type Layout = Extract<PresentationMutation, { kind: "importLayout" }>;
type Mapping = PresentationSnapshot["sourceMappings"][number];

function mappedId(mappings: readonly Mapping[], daemonId: DaemonId, kind: "folder" | "member", sourceId: string) {
  return mappings.find(item => item.daemonId === daemonId
    && item.sourceKind === kind && item.sourceId === sourceId)?.targetId ?? crypto.randomUUID();
}

export function projectLegacyPresentationLayout(input: {
  daemonId: DaemonId;
  projectId: ProjectId;
  logicalProjectId: LogicalProjectId;
  sidebar: WorkbenchThreadSidebarSnapshot;
  displayOrder: WorkbenchThreadDisplayOrder;
  sourceRevision: number;
  mappings: readonly Mapping[];
}): Layout {
  const { daemonId, projectId, logicalProjectId, sidebar, displayOrder, sourceRevision, mappings } = input;
  const sourceId = `project:${projectId}`;
  const folders: Layout["folders"] = [];
  const members: Layout["members"] = [];
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    for (const item of projectWorkbenchThreadDisplaySection(sidebar.entries, displayOrder, section)) {
      const folderSourceId = item.itemKind === "folder" ? `${sourceId}:folder:${item.folder.folderId}` : null;
      if (item.itemKind === "folder") folders.push({
        id: mappedId(mappings, daemonId, "folder", folderSourceId!), sourceId: folderSourceId!,
        scope: "project", logicalProjectId, title: item.folder.title, position: folders.length,
      });
      for (const entry of item.itemKind === "folder" ? item.entries : [item.entry]) {
        const memberSourceId = `${sourceId}:${section}:${getWorkbenchThreadDisplayKey(entry)}`;
        members.push({
          id: mappedId(mappings, daemonId, "member", memberSourceId), sourceId: memberSourceId,
          scope: "project", logicalProjectId, folderId: folderSourceId,
          kind: entry.entryKind === "draft" ? "draft" : "thread",
          draftId: entry.entryKind === "draft" ? entry.draft.draftId : null,
          thread: entry.entryKind === "draft" ? null : {
            location: { daemonId, projectId: ProjectIdSchema.parse(projectId) }, threadId: entry.identity.threadId,
          },
          position: members.length,
        });
      }
    }
  }
  return { kind: "importLayout", daemonId, sourceId, sourceRevision,
    scope: "project", logicalProjectId, folders, members };
}

export function homeLegacyPresentationLayout(input: {
  daemonId: DaemonId;
  sidebars: WorkbenchProjectThreadSidebars;
  displayOrder: WorkbenchHomeThreadDisplayOrder;
  sourceRevision: number;
  mappings: readonly Mapping[];
}): Layout {
  const { daemonId, sidebars, displayOrder, sourceRevision, mappings } = input;
  const layout = projectWorkbenchHomeThreadList(sidebars, displayOrder);
  const members: Layout["members"] = [];
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    const items = section === "pinned" ? layout.pinnedItems
      : section === "snoozed" ? layout.snoozedItems : layout.settledItems;
    for (const item of items) {
      for (const { entry, projectId } of item.itemKind === "folder" ? item.entries : [item.entry]) {
        const sourceId = `home:${getWorkbenchHomeThreadKey(projectId, entry)}`;
        members.push({
          id: mappedId(mappings, daemonId, "member", sourceId), sourceId,
          scope: "home", logicalProjectId: null, folderId: null, position: members.length,
          kind: entry.entryKind === "draft" ? "draft" : "thread",
          draftId: entry.entryKind === "draft" ? entry.draft.draftId : null,
          thread: entry.entryKind === "draft" ? null : {
            location: { daemonId, projectId: ProjectIdSchema.parse(projectId) }, threadId: entry.identity.threadId,
          },
        });
      }
    }
  }
  return { kind: "importLayout", daemonId, sourceId: "home", sourceRevision,
    scope: "home", logicalProjectId: null, folders: [], members };
}

export function pinnedLegacyPresentationLayout(input: {
  daemonId: DaemonId;
  sidebars: WorkbenchProjectThreadSidebars;
  displayOrder: WorkbenchThreadDisplayOrder;
  sourceRevision: number;
  mappings: readonly Mapping[];
}): Layout {
  const { daemonId, sidebars, displayOrder, sourceRevision, mappings } = input;
  const entries = sidebars.projects.flatMap(sidebar => sidebar.entries.flatMap(entry =>
    entry.entryKind !== "subagent" && getThreadSidebarGroup(entry) === "pinned"
      ? [{ entry, projectId: sidebar.projectId }] : []));
  const layoutEntries = entries.map(({ entry, projectId }) => ({
    key: getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry)),
    section: "pinned" as const,
  }));
  const items = projectThreadDisplayLayoutSection(entries, layoutEntries, displayOrder, "pinned");
  const folders: Layout["folders"] = [];
  const members: Layout["members"] = [];
  for (const item of items) {
    const folderSourceId = item.itemKind === "folder" ? `pinned:folder:${item.folder.folderId}` : null;
    if (item.itemKind === "folder") folders.push({
      id: mappedId(mappings, daemonId, "folder", folderSourceId!), sourceId: folderSourceId!,
      scope: "pinned", logicalProjectId: null, title: item.folder.title, position: folders.length,
    });
    for (const { entry, projectId } of item.itemKind === "folder" ? item.entries : [item.entry]) {
      const sourceId = `pinned:${getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry))}`;
      members.push({
        id: mappedId(mappings, daemonId, "member", sourceId), sourceId,
        scope: "pinned", logicalProjectId: null, folderId: folderSourceId, position: members.length,
        kind: entry.entryKind === "draft" ? "draft" : "thread",
        draftId: entry.entryKind === "draft" ? entry.draft.draftId : null,
        thread: entry.entryKind === "draft" ? null : {
          location: { daemonId, projectId }, threadId: entry.identity.threadId,
        },
      });
    }
  }
  return { kind: "importLayout", daemonId, sourceId: "pinned", sourceRevision,
    scope: "pinned", logicalProjectId: null, folders, members };
}
