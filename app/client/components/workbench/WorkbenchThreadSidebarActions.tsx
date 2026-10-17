/*
 * Exports:
 * - default WorkbenchThreadSidebarActionsProvider: own thread-sidebar mutations, menus (built from owners at call time), folder focus and action errors, and expose the colocated context hook.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { WorkbenchHarness, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import type { WorkbenchThreadRowDragPayload } from "../../workbench/layout/workbench-drag";
import { writeTextToClipboard } from "../../workbench/dom/clipboard";
import { getWorkbenchThreadDisplayKey, type WorkbenchThreadDisplayOrder, type WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayDraftKey, parseProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { FolderIdSchema, LogicalProjectIdSchema, ProjectIdSchema, type DraftId, type ProjectId, type ThreadDisplayKey, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  getThreadSidebarGroup,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchThreadStatusProviderOwned,
  isWorkbenchThreadSnoozeAvailable,
  isWorkbenchSidebarThreadCompletionAvailable,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadPriority,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import type {
  WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-sidebar-row";
import { getNeedsAttentionThreadStatusTone } from "./workbench-thread-status-colors";
import { getThreadStopIntent } from "./thread-row-actions";
import {
  ArchiveIcon,
  CompletedThreadIcon,
  CopyIcon,
  DiscardDraftIcon,
  FolderInputIcon,
  NeedsAttentionThreadIcon,
  OpenThreadIcon,
  PinIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  StoppedThreadIcon,
} from "./workbench-icons";
import WorkbenchComposerDraftPresenceProvider from "./WorkbenchComposerDraftPresenceProvider";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import { useWorkbenchClientController } from "./workbench-client-context";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";

type ThreadListEntry = WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry;

function isPinnedDraftSummaryEntry(entry: ThreadListEntry): entry is Extract<WorkbenchPinnedThreadSummaryEntry, { entryKind: "draft" }> {
  return entry.entryKind === "draft" && "draftId" in entry;
}

function targetForEntry(entry: ThreadListEntry): Extract<WorkbenchThreadTarget, { kind: "draft" | "provider" }> {
  return entry.entryKind === "draft"
    ? { draftId: isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function copyIdItem(identifier: string): WorkbenchContextMenuDefinition["items"][number] {
  return {
    icon: <CopyIcon size={16} />,
    id: "copy-id",
    label: "Copy ID",
    onSelect: () => { void writeTextToClipboard(identifier); },
  };
}

/** A listed thread whose row has not loaded only knows its identity, so its menu offers what needs nothing more. */
function getPendingThreadContextMenu(threadId: string, title: string): WorkbenchContextMenuDefinition {
  return { id: `thread:${threadId}`, items: [copyIdItem(threadId)], label: `Thread actions for ${title}`, placementScope: "thread-list" };
}

function boundedFolderMutationError(error: unknown) {
  return (error instanceof Error ? error.message : "The thread folder mutation failed.").slice(0, 500);
}

interface WorkbenchThreadSidebarActionsValue {
  autoFocusFolderId: string | null;
  /** The last failed action; sidebar load errors live with the sidebar. */
  error: string;
  getThreadContextMenu: (entry: ThreadListEntry, ownerProjectId: ProjectId, folderScope?: "pinned" | "project") => WorkbenchContextMenuDefinition;
  getThreadContextMenuFor: (entry: ThreadListEntry,
    folderScope?: "pinned" | "project") => WorkbenchContextMenuDefinition | null;
  getPendingThreadContextMenu: (threadId: string, title: string) => WorkbenchContextMenuDefinition;
  onAction: (entry: ThreadListEntry, action: import("./thread-row-actions").ThreadRowAction, ownerProjectId: ProjectId) => void;
  onActionFor: (entry: ThreadListEntry, action: import("./thread-row-actions").ThreadRowAction) => void;
  onAutoFocusFolderComplete: () => void;
  onMove: (sourceKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null, beforeKey: string | null, ownerProjectId?: ProjectId) => void;
  onProjectFolderDrop: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null) => void;
  onPinnedFolderDrop: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetKey: ThreadDisplayKey, destinationFolderId: string | null) => void;
  onSetPriority: (payload: WorkbenchThreadRowDragPayload, priority: WorkbenchThreadPriority) => void;
  onSnoozeUntil: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetIdentity: { harness: WorkbenchHarness; threadId: WorkbenchThreadId }) => void;
  onHomeMove: (sourceKey: string, section: WorkbenchThreadDisplaySection, destinationFolderKey: string | null, beforeKey: string | null) => void;
  onPinnedMove: (sourceKey: string, destinationFolderId: string | null, beforeKey: string | null) => void;
  onRenamePinnedFolder: (folderId: string, title: string) => Promise<string>;
  onRenameFolder: (folderId: string, title: string, ownerProjectId?: ProjectId) => Promise<string>;
}

const WorkbenchThreadSidebarActionsContext = createContext<WorkbenchThreadSidebarActionsValue | null>(null);

function useWorkbenchThreadSidebarActions() {
  const value = useContext(WorkbenchThreadSidebarActionsContext);
  if (!value) throw new Error("Workbench thread sidebar actions require WorkbenchThreadSidebarActionsProvider.");
  return value;
}

function WorkbenchThreadSidebarActionsProvider({
  children,
  onOpenThread,
  onThreadSettled,
  onPresentationDraftDeleted,
  onOpenQualifiedThread,
  projectId,
}: {
  children: ReactNode;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  onThreadSettled: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  onPresentationDraftDeleted?: (draftId: DraftId, logicalProjectId: string) => void;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
  projectId: ProjectId | "";
}) {
  const client = useWorkbenchClientController();
  const controls = client.controls;
  // Rows, folders, sidebars and runtime threads matter only when an action runs or a menu is built, so they are read
  // from their owners then; subscribing would re-render every list consumer on every thread's activity.
  const sidebarStore = client.mounted?.threadSidebar ?? null;
  const runtime = client.mounted?.threadRuntime ?? null;
  const readRows = useCallback(() => sidebarStore?.getListing?.().rows ?? [], [sidebarStore]);
  const qualifiedForEntry = useCallback((entry: ThreadListEntry) => {
    const id = entry.entryKind === "draft"
      ? isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId
      : entry.identity.threadId;
    const matches = readRows().filter(row => row.entry.entryKind === "draft"
      ? entry.entryKind === "draft" && row.entry.draft.draftId === id
      : entry.entryKind !== "draft" && row.entry.identity.threadId === id);
    if (matches.length > 1) {
      console.error("Thread UUID has conflicting visible rows.");
      return null;
    }
    return matches[0] ?? null;
  }, [readRows]);
  const [autoFocusFolderId, setAutoFocusFolderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const projectFacts = client.mounted?.projectFacts ?? null;
  const layoutProject = useCallback((id: string) => {
    const projects = projectFacts?.getProjects() ?? [];
    const exact = projects.find(project => project.id === id);
    if (exact) return exact.id;
    const matches = projects.filter(project => project.locations.some(location => location.target.projectId === id));
    if (matches.length !== 1) throw new Error("The folder's app project identity is not available.");
    return matches[0]!.id;
  }, [projectFacts]);
  const layoutKey = useCallback((key: string) => {
    if (key.startsWith("folder:")) return key;
    const qualified = parseProjectQualifiedThreadDisplayKey(key);
    if (!qualified) throw new Error("The layout item has no project identity.");
    return getProjectQualifiedThreadDisplayKey(layoutProject(qualified.projectId), qualified.threadKey);
  }, [layoutProject]);

  const mutateEntry = useCallback(async (entry: ThreadListEntry, ownerProjectId: ProjectId, method: "archive/set" | "pin/set" | "restore" | "settle" | "snooze/set" | "status/set", value?: boolean | "completed" | "needsAttention" | "stopped", source?: ProjectLocationReference) => {
    if (!controls || !ownerProjectId) return;
    if (entry.entryKind === "draft") {
      const draftId = isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId;
      if (method === "pin/set" || method === "snooze/set") {
        await controls.setPresentationDraftPriority(draftId, {
          pinned: method === "pin/set" ? Boolean(value) : entry.metadata.pinned,
          snoozed: method === "snooze/set" ? Boolean(value) : entry.metadata.snoozed,
        });
        return;
      }
      return;
    }
    const identity = entry.identity;
    const intent = method === "pin/set"
        ? { kind: "pin" as const, pinned: Boolean(value) }
        : method === "snooze/set"
          ? { kind: "snooze" as const, snoozed: Boolean(value) }
          : method === "archive/set"
            ? { kind: "archive" as const, archived: Boolean(value) }
            : method === "status/set"
              ? { kind: "status" as const, status: value === "needsAttention" ? "needsAttention" as const
                : value === "stopped" ? "stopped" as const : "completed" as const }
              : { kind: method === "restore" ? "restore" as const : "settle" as const };
    const accepted = await controls.threadAction(identity.threadId, intent);
    if (method === "settle" && accepted) {
      onThreadSettled({ harness: identity.harness, kind: "provider", threadId: identity.threadId }, ownerProjectId);
    }
  }, [controls, onThreadSettled]);

  const runDragMutation = useCallback((operation: () => Promise<void | boolean>, failureLabel: string, folderId?: string) => {
    if (!controls) return;
    void Promise.resolve().then(operation).then((accepted) => {
      if (accepted === false) throw new Error("The owning daemon rejected this action.");
      setActionError("");
    }).catch((error: unknown) => {
      if (folderId) setAutoFocusFolderId((current) => current === folderId ? null : current);
      const message = boundedFolderMutationError(error);
      setActionError(message);
      console.error(failureLabel, message);
    });
  }, [controls]);

  const getThreadContextMenu = useCallback((entry: ThreadListEntry, ownerProjectId: ProjectId,
    folderScope?: "pinned" | "project", source?: ProjectLocationReference,
    logicalProjectId?: string): WorkbenchContextMenuDefinition => {
    const thread = !source && entry.entryKind === "thread" && ownerProjectId === projectId
      ? runtime?.getSnapshot().threads.find(candidate => candidate.id === entry.identity.threadId) ?? null : null;
    const threadFolders = sidebarStore?.getListing?.().folders;
    const pinnedThreadLayout = sidebarStore?.getPinnedThreadLayout?.() ?? null;
    const target = targetForEntry(entry);
    const draftId = target.kind === "draft" ? target.draftId : null;
    const identifier = target.kind === "draft" ? target.draftId : target.threadId;
    const qualifiedRow = source && logicalProjectId ? readRows().find(row =>
      row.logicalProjectId === logicalProjectId
      && row.location.daemonId === source.daemonId && row.location.projectId === source.projectId
      && (target.kind === "draft" ? row.entry.entryKind === "draft"
        && row.entry.draft.draftId === target.draftId
        : row.entry.entryKind !== "draft" && row.entry.identity.threadId === target.threadId)) : null;
    const pinned = isPinnedDraftSummaryEntry(entry) ? true : entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
    const group = isPinnedDraftSummaryEntry(entry) ? "pinned" : getThreadSidebarGroup(entry);
    const terminal = entry.entryKind !== "draft" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped");
    const items: WorkbenchContextMenuDefinition["items"] = [{
      icon: <OpenThreadIcon size={16} />,
      id: "open",
      label: "Open",
      onSelect: () => {
        if (source) {
          if (qualifiedRow) onOpenQualifiedThread?.(qualifiedRow);
        } else onOpenThread(target, ownerProjectId);
      },
    }];

    if (terminal && group !== "archived" && entry.lifecycle.settled) {
      items.push({
        icon: <RestoreThreadIcon size={16} />,
        id: "restore",
        label: "Restore",
        onSelect: () => mutateEntry(entry, ownerProjectId, "restore", undefined, source),
      });
    }

    items.push(copyIdItem(identifier));

    const localDisplayKey = isPinnedDraftSummaryEntry(entry) ? getThreadDisplayDraftKey(entry.draftId) : getWorkbenchThreadDisplayKey(entry);
    const useProjectFolder = folderScope === "project"
      || (folderScope !== "pinned" && (!projectId || group !== "pinned"));
    const displayKey = useProjectFolder ? localDisplayKey : getProjectQualifiedThreadDisplayKey(
      qualifiedRow?.logicalProjectId ?? ownerProjectId, localDisplayKey,
    );
    const ownerSidebar = sidebarStore?.getProjectSnapshot(ownerProjectId) ?? null;
    // The app server projects saved folders from every listed row, including rows whose summary is still loading.
    const appOrder = source && qualifiedRow && threadFolders
      ? { folders: useProjectFolder
        ? threadFolders.projects[LogicalProjectIdSchema.parse(qualifiedRow.logicalProjectId)] ?? []
        : threadFolders.pinned }
      : null;
    const folderIn = (order: WorkbenchThreadDisplayOrder | null | undefined) =>
      order?.folders?.find(item => item.threadKeys.includes(displayKey)) ?? null;
    const folder = appOrder
      ? folderIn(appOrder)
      : useProjectFolder
        ? folderIn(ownerSidebar?.displayOrder)
        : folderIn(pinnedThreadLayout?.displayOrder);
    if (entry.entryKind !== "subagent" && (group === "pinned" || group === "snoozed" || group === "settled") && !folder) {
      items.push({
        icon: <FolderInputIcon size={16} />,
        id: "add-to-folder",
        label: "Add to folder",
        onSelect: () => {
          if (!controls) return;
          if (source && !qualifiedRow) return;
          const folderId = FolderIdSchema.parse(crypto.randomUUID());
          setAutoFocusFolderId(folderId);
          if (source) {
            if (!qualifiedRow) return;
            const mutation = useProjectFolder
              ? controls.updatePresentationProjectLayout(qualifiedRow.logicalProjectId, {
                kind: "drop", section: group === "snoozed" ? "snoozed"
                  : group === "settled" ? "settled" : "pinned",
                sourceKey: localDisplayKey, targetKey: localDisplayKey,
                destinationFolderId: null, folderId,
              })
              : controls.updatePresentationPinnedLayout({
                kind: "drop", sourceKey: displayKey, targetKey: displayKey,
                destinationFolderId: null, folderId,
              });
            void mutation.catch(error => {
              setAutoFocusFolderId(current => current === folderId ? null : current);
              console.error("Unable to create the thread folder.", boundedFolderMutationError(error));
            });
            return;
          }
          runDragMutation(() => group === "pinned" && !useProjectFolder
            ? controls.updatePresentationPinnedLayout({
              kind: "drop", sourceKey: layoutKey(displayKey), targetKey: layoutKey(displayKey),
              destinationFolderId: null, folderId,
            })
            : controls.updatePresentationProjectLayout(layoutProject(ownerProjectId), {
              kind: "drop", section: group === "snoozed" ? "snoozed" : group === "settled" ? "settled" : "pinned",
              sourceKey: localDisplayKey, targetKey: localDisplayKey, destinationFolderId: null, folderId,
            }), "Unable to create the thread folder.", folderId);
        },
      });
    }

    const snoozed = group === "snoozed";
    items.push({ id: "priority-separator", kind: "separator" }, {
      closeOnSelect: false,
      controls: [{
        checked: pinned,
        disabled: group === "archived",
        icon: <PinIcon size={16} />,
        id: "pin",
        label: pinned ? "Unpin thread" : "Pin thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "pin/set", !pinned, source),
      }, {
        checked: snoozed,
        disabled: group === "archived" || (!snoozed && !isWorkbenchThreadSnoozeAvailable(entry)),
        icon: <SnoozedThreadIcon size={16} />,
        id: "snooze",
        label: snoozed ? "Wake" : "Snooze thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "snooze/set", !snoozed, source),
      }],
      id: "priority",
      kind: "control-group",
      label: "Priority",
      presentation: "independent",
    });

    if (entry.entryKind === "thread") {
      const providerOwned = isWorkbenchThreadStatusProviderOwned(entry.lifecycle);
      const canComplete = isWorkbenchSidebarThreadCompletionAvailable(entry);
      const selectStatus = (status: "completed" | "needsAttention" | "stopped") => {
        if (providerOwned && !(status === "completed" && canComplete)) {
          if (status === "stopped" && controls) {
            const stopEntry = "pendingQuestionnaire" in entry ? entry
              : qualifiedRow?.entry.entryKind === "thread" ? qualifiedRow.entry : null;
            runDragMutation(
              () => {
                if (!stopEntry) throw new Error("The thread's current sidebar state is unavailable.");
                return controls.threadAction(entry.identity.threadId, getThreadStopIntent(stopEntry));
              },
              "Unable to stop owning thread",
            );
          }
          return;
        }
        if (entry.lifecycle.kind !== status) void mutateEntry(
          entry, ownerProjectId, "status/set", status, source,
        ).catch(error => console.error("Thread status failed", boundedFolderMutationError(error)));
      };
      items.push({ id: "status-separator", kind: "separator" }, {
        closeOnSelect: false,
        controls: [{
          checked: entry.lifecycle.kind === "needsAttention",
          disabled: group === "archived" || entry.lifecycle.kind === "working",
          icon: <NeedsAttentionThreadIcon size={16} />,
          id: "needs-attention",
          label: "Needs attention",
          onSelect: () => selectStatus("needsAttention"),
          tone: getNeedsAttentionThreadStatusTone(!entry.metadata.snoozed),
        }, {
          checked: entry.lifecycle.kind === "completed",
          disabled: group === "archived" || (providerOwned && !canComplete),
          icon: <CompletedThreadIcon size={16} />,
          id: "completed",
          label: "Completed",
          onSelect: () => selectStatus("completed"),
          tone: "completed",
        }, {
          checked: entry.lifecycle.kind === "stopped",
          disabled: group === "archived" || (providerOwned && !thread && !source),
          icon: <StoppedThreadIcon size={16} />,
          id: "stopped",
          label: "Stopped",
          onSelect: () => selectStatus("stopped"),
          tone: "stopped",
        }],
        id: "status",
        kind: "control-group",
        label: "Status",
        presentation: "connected",
      });
    }

    // The row that opened this menu leases its summary, so its required todos are known here.
    const requiredTodoCount = entry.entryKind === "draft" ? 0
      : client.mounted?.threadSummaries?.get(entry.identity.threadId)?.summary.facts.requiredTodoCount ?? 0;
    if (group === "archived" || (entry.entryKind !== "draft" && isWorkbenchThreadSettlementAvailable(entry, { requiredTodoCount }))) {
      items.push({ id: "conclude-separator", kind: "separator" }, {
        controls: group === "archived" ? [{
          checked: false,
          icon: <RestoreThreadIcon size={16} />,
          id: "restore",
          label: "Restore",
          onSelect: () => mutateEntry(entry, ownerProjectId, "restore", undefined, source),
        }] : [
          {
            checked: false,
            icon: <SettleThreadIcon size={16} />,
            id: "settle",
            label: "Settle",
            onSelect: () => mutateEntry(entry, ownerProjectId, "settle", undefined, source),
          },
          {
            checked: false,
            icon: <ArchiveIcon size={16} />,
            id: "archive",
            label: "Archive",
            onSelect: () => mutateEntry(entry, ownerProjectId, "archive/set", true, source),
          },
        ],
        id: "conclude",
        kind: "control-group",
        label: "Conclude",
        presentation: "actions",
      });
    }
    if (draftId) {
      items.push({ id: "discard-separator", kind: "separator" }, {
        disabled: !controls,
        icon: <DiscardDraftIcon size={16} />,
        id: "discard",
        label: "Discard draft",
        onSelect: () => {
          const deletion = source ? controls?.deletePresentationDraft(draftId)
            : controls?.deleteThreadDraft(draftId, ownerProjectId);
          void deletion?.then(() => {
            if (source && logicalProjectId) onPresentationDraftDeleted?.(draftId, logicalProjectId);
          }).catch(error => console.error("Draft discard failed", boundedFolderMutationError(error)));
        },
        tone: "danger",
      });
    }
    return { id: `thread:${identifier}`, items, label: `Thread actions for ${entry.title}`, placementScope: "thread-list" };
  }, [controls, mutateEntry, onOpenQualifiedThread, onOpenThread, onPresentationDraftDeleted, projectId, readRows,
    runtime, sidebarStore, layoutKey, layoutProject, runDragMutation]);

  const value = useMemo<WorkbenchThreadSidebarActionsValue>(() => ({
    autoFocusFolderId,
    error: actionError,
    getThreadContextMenu,
    getPendingThreadContextMenu,
    getThreadContextMenuFor: (entry, folderScope) => {
      const row = qualifiedForEntry(entry);
      return row ? getThreadContextMenu(entry, row.location.projectId, folderScope,
        row.location, row.logicalProjectId) : null;
    },
    onAction: (entry, action, ownerProjectId) => {
      if (entry.entryKind === "draft") {
        if (action === "discard" && !isPinnedDraftSummaryEntry(entry)) void controls?.deleteThreadDraft(entry.draft.draftId);
        return;
      }
      if (action === "discard") return;
      const mutations = {
        archive: () => mutateEntry(entry, ownerProjectId, "archive/set", true),
        complete: () => mutateEntry(entry, ownerProjectId, "status/set", "completed"),
        restore: () => mutateEntry(entry, ownerProjectId, "restore"),
        settle: () => mutateEntry(entry, ownerProjectId, "settle"),
        snooze: () => mutateEntry(entry, ownerProjectId, "snooze/set", true),
        wake: () => mutateEntry(entry, ownerProjectId, "snooze/set", false),
      };
      void mutations[action]().catch(error => console.error("Thread action failed", boundedFolderMutationError(error)));
    },
    onActionFor: (entry, action) => {
      const row = qualifiedForEntry(entry);
      if (!row) return;
      const source = row.location;
      const logicalProjectId = row.logicalProjectId;
      if (entry.entryKind === "draft") {
        const draftId = isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId;
        if (action === "discard") {
          void controls?.deletePresentationDraft(draftId).then(() =>
            onPresentationDraftDeleted?.(draftId, logicalProjectId)).catch(error =>
            console.error("Draft deletion failed", boundedFolderMutationError(error)));
        }
        if (action === "snooze" || action === "wake") {
          void mutateEntry(entry, source.projectId, "snooze/set", action === "snooze", source)
            .catch(error => console.error("Draft priority failed", boundedFolderMutationError(error)));
        }
        return;
      }
      if (action === "discard") return;
      const projectId = source.projectId;
      const mutations = {
        archive: () => mutateEntry(entry, projectId, "archive/set", true, source),
        complete: () => mutateEntry(entry, projectId, "status/set", "completed", source),
        restore: () => mutateEntry(entry, projectId, "restore", undefined, source),
        settle: () => mutateEntry(entry, projectId, "settle", undefined, source),
        snooze: () => mutateEntry(entry, projectId, "snooze/set", true, source),
        wake: () => mutateEntry(entry, projectId, "snooze/set", false, source),
      };
      void mutations[action]().catch(error => console.error("Thread action failed", boundedFolderMutationError(error)));
    },
    onAutoFocusFolderComplete: () => setAutoFocusFolderId(null),
    onMove: (sourceKey, section, destinationFolderId, beforeKey, ownerProjectId = projectId || undefined) => {
      if (!ownerProjectId || !controls) return;
      runDragMutation(() => controls.updatePresentationProjectLayout(layoutProject(ownerProjectId), {
        kind: "move", beforeKey, destinationFolderId, section, sourceKey,
      }), "Unable to move the thread.");
    },
    onProjectFolderDrop: (payload, targetProjectId, targetKey, section, destinationFolderId) => {
      if (payload.ownerProjectId !== targetProjectId || !controls) return;
      const folderId = destinationFolderId ? undefined : crypto.randomUUID();
      if (folderId) setAutoFocusFolderId(folderId);
      runDragMutation(() => controls.updatePresentationProjectLayout(layoutProject(targetProjectId), {
        kind: "drop", destinationFolderId, folderId, section, sourceKey: payload.projectSourceKey, targetKey,
      }), "Unable to group the dragged thread.", folderId);
    },
    onPinnedFolderDrop: (payload, targetProjectId, targetKey, destinationFolderId) => {
      if (!controls) return;
      const folderId = destinationFolderId ? undefined : crypto.randomUUID();
      if (folderId) setAutoFocusFolderId(folderId);
      runDragMutation(() => controls.updatePresentationPinnedLayout({
        kind: "drop", destinationFolderId, folderId,
        sourceKey: getProjectQualifiedThreadDisplayKey(layoutProject(payload.ownerProjectId), payload.projectSourceKey),
        targetKey: getProjectQualifiedThreadDisplayKey(layoutProject(targetProjectId), targetKey),
      }), "Unable to group the dragged pinned thread.", folderId);
    },
    onSetPriority: (payload, priority) => {
      if (!controls || payload.target.kind !== "thread") return;
      const target = payload.target.target;
      runDragMutation(async () => {
        if (target.kind === "draft") return controls.setPresentationDraftPriority(target.draftId, {
          pinned: priority === "pinned", snoozed: priority === "snoozed",
        });
        if (target.kind !== "provider" && target.kind !== "subagent") throw new Error("This item cannot change sidebar priority.");
        return controls.threadAction(target.threadId, { kind: "priority", priority });
      }, "Unable to change the dragged thread priority.");
    },
    onSnoozeUntil: (payload, targetProjectId, targetIdentity) => {
      const source = payload.target.kind === "thread" ? payload.target.target : null;
      if (source?.kind !== "provider" || !controls) return;
      runDragMutation(() => controls.threadAction(source.threadId, {
        kind: "snoozeUntil", targetThreadId: targetIdentity.threadId,
      }), "Unable to change the dragged thread's wait target.");
    },
    onHomeMove: (sourceKey, section, destinationFolderKey, beforeKey) => {
      if (!controls) return;
      runDragMutation(() => controls.updatePresentationHomeLayout({
        beforeKey: beforeKey ? layoutKey(beforeKey) : null,
        destinationFolderKey: destinationFolderKey ? layoutKey(destinationFolderKey) : null,
        section, sourceKey: layoutKey(sourceKey),
      }), "Unable to move the home item.");
    },
    onPinnedMove: (sourceKey, destinationFolderId, beforeKey) => {
      if (!controls) return;
      runDragMutation(() => controls.updatePresentationPinnedLayout({
        kind: "move", beforeKey: beforeKey ? layoutKey(beforeKey) : null,
        destinationFolderId, sourceKey: layoutKey(sourceKey),
      }), "Unable to move the pinned item.");
    },
    onRenamePinnedFolder: async (folderId, title) => {
      if (!controls) throw new Error("The app connection is unavailable.");
      await controls.updatePresentationPinnedLayout({ kind: "rename", folderId, title });
      return title.trim();
    },
    onRenameFolder: async (folderId, title, ownerProjectId = projectId || undefined) => {
      if (!ownerProjectId || !controls) throw new Error("A project must be selected before renaming a folder.");
      await controls.updatePresentationProjectLayout(layoutProject(ownerProjectId), { kind: "rename", folderId, title });
      return title.trim();
    },
  }), [actionError, autoFocusFolderId, controls, getThreadContextMenu, mutateEntry, onPresentationDraftDeleted, projectId,
    qualifiedForEntry, runDragMutation, layoutKey, layoutProject]);

  return (
    <WorkbenchComposerDraftPresenceProvider>
      <WorkbenchThreadSidebarActionsContext.Provider value={value}>
        {children}
      </WorkbenchThreadSidebarActionsContext.Provider>
    </WorkbenchComposerDraftPresenceProvider>
  );
}

export default Object.assign(WorkbenchThreadSidebarActionsProvider, {
  useActions: useWorkbenchThreadSidebarActions,
});
