/*
 * Exports:
 * - GitObjectOpen: opens a commit, stash or the changes in a git tab, replacing the preview tab or as a kept one.
 * - GitMenuObject: the commit or stash a sidebar row was right-clicked on.
 * - default useGitObjectMenu: right-click menus for history and stash rows: open (here or kept), restore and hold-drop for
 *   stashes, copy sha and message. A restore that leaves conflicts opens the changes; a failed move opens the stash itself.
 */
"use client";
import { useCallback, type MouseEvent } from "react";
import type { WorkbenchGitObject } from "workbench-shared/workbench/navigation/git-route-target";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { readGitObjectDetail } from "../../../workbench/git/git-object-details";
import { useWorkbenchContextMenu, type WorkbenchContextMenuItem } from "../WorkbenchContextMenuContext";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { AppWindowIcon, CopyIcon, EyeIcon, GitStashIcon, TextQuoteIcon, Trash2Icon } from "../workbench-icons";

export type GitObjectOpen = (object: WorkbenchGitObject, tab: "preview" | "durable") => void;
export type GitMenuObject = { kind: "commit" | "stash"; sha: string; named: boolean };

const DROP_HOLD_MS = 1_000;

export default function useGitObjectMenu(location: ProjectLocationReference, open: GitObjectOpen) {
  const menu = useWorkbenchContextMenu();
  const daemon = useWorkbenchDaemonClient();
  return useCallback((event: MouseEvent, object: GitMenuObject) => {
    event.preventDefault();
    const target = { kind: object.kind, sha: object.sha };
    const copy = (text: string) => { void navigator.clipboard.writeText(text); };
    const move = async (action: "restoreStash" | "dropStash") => {
      try {
        const result = await daemon.git.mutateRef({ projectId: location.projectId, action, sha: object.sha });
        if (result.status === "complete" && result.conflicts.length) open({ kind: "changes" }, "preview");
      } catch {
        open(target, "preview");
      }
    };
    const stashItems: WorkbenchContextMenuItem[] = object.kind === "stash" ? [
      { id: "restore", icon: <GitStashIcon size={16} />, label: "Restore", onSelect: () => { void move("restoreStash"); } },
      { id: "drop", icon: <Trash2Icon size={16} />, label: "Drop", tone: "danger", holdToConfirmMs: DROP_HOLD_MS,
        onSelect: () => { void move("dropStash"); } },
      { id: "stash-separator", kind: "separator" },
    ] : [];
    const items: WorkbenchContextMenuItem[] = [
      { id: "open", icon: <EyeIcon size={16} />, label: "Open", onSelect: () => open(target, "preview") },
      { id: "open-kept", icon: <AppWindowIcon size={16} />, label: "Open in new tab", onSelect: () => open(target, "durable") },
      { id: "open-separator", kind: "separator" },
      ...stashItems,
      { id: "copy-sha", icon: <CopyIcon size={16} />, label: "Copy SHA", onSelect: () => copy(object.sha) },
      { id: "copy-message", icon: <TextQuoteIcon size={16} />, label: "Copy message", disabled: !object.named, onSelect: () => {
        void readGitObjectDetail(daemon, location, target)
          .then(detail => copy(detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject), () => undefined);
      } },
    ];
    menu.openContextMenu({
      x: event.clientX, y: event.clientY,
      menu: { id: `git-${object.kind}:${object.sha}`, label: object.kind === "stash" ? "Stash" : "Commit", items },
    });
  }, [daemon, location, menu, open]);
}
