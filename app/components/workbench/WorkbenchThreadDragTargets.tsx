/*
 * Exports:
 * - default WorkbenchThreadDragTargets: render compatible folder and dependent-snooze drop cards beside one sidebar thread row.
 */
"use client";

import { useEffect, type ReactNode } from "react";

import {
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import type { WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import { FolderInputIcon, SnoozedThreadIcon } from "./workbench-icons";
import DropTarget from "./drag/DropTarget";

interface ThreadIdentity {
  harness: WorkbenchHarnessId;
  threadId: string;
}

function sourceIdentity(payload: WorkbenchThreadRowDragPayload): ThreadIdentity | null {
  const target = payload.target.kind === "thread" ? payload.target.target : null;
  return target?.kind === "provider" && target.harness
    ? { harness: target.harness, threadId: target.threadId }
    : null;
}

function DropSelectionEffect({ onChange, selected }: { onChange: (selected: boolean) => void; selected: boolean }) {
  useEffect(() => {
    onChange(selected);
    return () => onChange(false);
  }, [onChange, selected]);
  return null;
}

function TargetCard({ children, hoverScope, kind, label, selected, targetProjectId }: {
  children: ReactNode;
  hoverScope: "folder" | "row";
  kind: "dependent-snooze" | "folder";
  label: string;
  selected: boolean;
  targetProjectId?: string;
}) {
  const hoverClassName = hoverScope === "folder"
    ? " group-hover/thread-folder:opacity-100"
    : " group-hover/thread-row:opacity-100";
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none inline-flex size-9 items-center justify-center rounded-[0.7rem] border text-muted backdrop-blur transition ${
        selected
          ? "border-accent bg-accent-soft text-accent opacity-100"
          : `border-[color-mix(in_srgb,var(--text)_14%,transparent)] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] opacity-0${hoverClassName}`
      }`}
      data-thread-drag-target={kind}
      data-thread-drag-target-project={targetProjectId || undefined}
      data-thread-drag-target-scope={hoverScope}
      title={label}
    >
      {children}
    </div>
  );
}

export default function WorkbenchThreadDragTargets({
  activePayload,
  folderLabel,
  folderTargetClassName,
  hoverScope = "row",
  onFolderDrop,
  onFolderSelectedChange,
  onSnoozeUntilDrop,
  targetIdentity,
  targetProjectId,
  targetTitle,
}: {
  activePayload: WorkbenchDragPayload | null;
  folderLabel?: string;
  folderTargetClassName?: string;
  hoverScope?: "folder" | "row";
  onFolderDrop?: (payload: WorkbenchThreadRowDragPayload) => void;
  onFolderSelectedChange?: (selected: boolean) => void;
  onSnoozeUntilDrop?: (payload: WorkbenchThreadRowDragPayload) => void;
  targetIdentity: ThreadIdentity | null;
  targetProjectId?: string;
  targetTitle: string;
}) {
  if (!activePayload || !isWorkbenchThreadRowDragPayload(activePayload)) return null;
  const draggedIdentity = sourceIdentity(activePayload);
  const sameTarget = Boolean(
    draggedIdentity
    && targetIdentity
    && targetProjectId
    && activePayload.ownerProjectId === targetProjectId
    && draggedIdentity.harness === targetIdentity.harness
    && draggedIdentity.threadId === targetIdentity.threadId,
  );
  if (sameTarget) return null;
  const showFolder = Boolean(onFolderDrop);
  const showSnooze = Boolean(onSnoozeUntilDrop && draggedIdentity && targetIdentity);
  if (!showFolder && !showSnooze) return null;

  return (
    <>
      {showFolder ? (
        <DropTarget
          className={folderTargetClassName ?? "absolute left-0 top-1/2 z-40 size-9 -translate-y-1/2"}
          dropTargetId={WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID}
          enabled={isWorkbenchThreadRowDragPayload}
          onDrop={(payload) => { if (isWorkbenchThreadRowDragPayload(payload)) onFolderDrop?.(payload); }}
          preview={() => ({ action: "folder", label: folderLabel ?? "add to folder" })}
          selectionPriority={folderTargetClassName ? 20 : 100}
        >
          {({ selected }) => (
            <>
              {onFolderSelectedChange ? <DropSelectionEffect onChange={onFolderSelectedChange} selected={selected} /> : null}
              <div className={folderTargetClassName ? "absolute left-0 top-1/2 size-9 -translate-y-1/2" : ""}>
                <TargetCard hoverScope={hoverScope} kind="folder" label={folderLabel ?? "Add to folder"} selected={selected} targetProjectId={targetProjectId}>
                  <FolderInputIcon size={16} />
                </TargetCard>
              </div>
            </>
          )}
        </DropTarget>
      ) : null}
      {showSnooze ? (
        <DropTarget
          className="absolute right-0 top-1/2 z-40 size-9 -translate-y-1/2"
          dropTargetId={WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID}
          enabled={(payload) => isWorkbenchThreadRowDragPayload(payload) && Boolean(sourceIdentity(payload))}
          onDrop={(payload) => { if (isWorkbenchThreadRowDragPayload(payload)) onSnoozeUntilDrop?.(payload); }}
          preview={() => ({ action: "snoozed", label: `wait for ${targetTitle}` })}
          selectionPriority={100}
        >
          {({ selected }) => (
            <TargetCard hoverScope={hoverScope} kind="dependent-snooze" label={`Snooze until ${targetTitle} is completed without claims`} selected={selected} targetProjectId={targetProjectId}>
              <SnoozedThreadIcon size={16} />
            </TargetCard>
          )}
        </DropTarget>
      ) : null}
    </>
  );
}
