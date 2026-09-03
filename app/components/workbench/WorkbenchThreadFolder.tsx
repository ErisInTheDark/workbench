/*
 * Exports:
 * - default WorkbenchThreadFolder: own one editable, status-toned sidebar folder disclosure with tooltip, drag, drop, and hover-open lifecycle. Keywords: thread, folder, disclosure, tooltip, drag.
 * - Local helpers: bound rename errors, rank folder lifecycle tone, and open a selected drag target after one owned delay. Keywords: folder, status, error, timer.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { WORKBENCH_THREAD_ORDER_DROP_TARGET_ID, type WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import { parseProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchThreadFolderKey,
  type WorkbenchThreadFolder,
} from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchPinnedThreadSummaryEntry, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import {
  getNeedsAttentionThreadStatusTone,
  getWorkbenchThreadStatusClassName,
  type WorkbenchThreadStatusTone,
} from "./workbench-thread-status-colors";
import { CompletedThreadIcon, DraftThreadIcon, FolderClosedIcon, FolderOpenIcon, NeedsAttentionThreadIcon, ProposedCommitThreadIcon, StoppedThreadIcon, WorkingThreadIcon } from "./workbench-icons";
import WorkbenchTooltip from "./WorkbenchTooltip";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import WorkbenchThreadListFullRowContent from "./WorkbenchThreadListFullRowContent";

const THREAD_FOLDER_HOVER_OPEN_DELAY_MS = 1_000;

function boundedFolderError(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to update the folder name.").slice(0, 160);
}

type FolderEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> | WorkbenchPinnedThreadSummaryEntry;
type FolderStatusIcon = ComponentType<{ className?: string }>;

function folderStatusRank(entry: FolderEntry) {
  if (entry.entryKind === "draft") return 5;
  if (entry.lifecycle.kind === "needsAttention") return 0;
  if (entry.lifecycle.kind === "working" && !entry.waitingFor) return 1;
  if (entry.waitingFor) return 2;
  if (entry.lifecycle.kind === "stopped") return 3;
  return 4;
}

function getFolderStatus(entries: readonly FolderEntry[], attentionLabelsByThreadId: Record<string, string | undefined>) {
  const entry = [...entries].sort((left, right) => folderStatusRank(left) - folderStatusRank(right))[0]!;
  if (entry.entryKind === "draft") return { dashed: true, Icon: DraftThreadIcon as FolderStatusIcon, label: "Draft", statusClassName: "text-muted", strokeOpacity: 0.24 };
  const waiting = Boolean(entry.waitingFor);
  const proposed = !waiting && entry.lifecycle.kind === "completed" && Boolean(entry.gitArc?.proposals.some(({ status }) => status === "proposed"));
  const tone: WorkbenchThreadStatusTone = waiting
    ? "waiting"
    : entry.lifecycle.kind === "needsAttention"
    ? getNeedsAttentionThreadStatusTone(entry.gitArc?.phase === "active")
    : entry.lifecycle.kind;
  const Icon = waiting ? WorkingThreadIcon : proposed ? ProposedCommitThreadIcon : entry.lifecycle.kind === "needsAttention" ? NeedsAttentionThreadIcon : entry.lifecycle.kind === "working" ? WorkingThreadIcon : entry.lifecycle.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
  return {
    dashed: !waiting && (entry.lifecycle.kind === "needsAttention" || entry.lifecycle.kind === "stopped"),
    Icon: Icon as FolderStatusIcon,
    label: waiting ? "Waiting" : proposed ? "Proposed commit" : entry.lifecycle.kind === "needsAttention" ? attentionLabelsByThreadId[entry.identity.threadId]?.trim() || "Needs attention" : entry.lifecycle.kind === "working" ? "Working" : entry.lifecycle.kind === "stopped" ? "Stopped" : "Completed",
    statusClassName: getWorkbenchThreadStatusClassName(tone),
    strokeOpacity: 1,
  };
}

function FolderHoverOpenTarget({ onOpen, onSelectedChange, open, selected }: { onOpen: () => void; onSelectedChange: (selected: boolean) => void; open: boolean; selected: boolean }) {
  useEffect(() => {
    onSelectedChange(selected);
    return () => onSelectedChange(false);
  }, [onSelectedChange, selected]);
  useEffect(() => {
    if (open || !selected) return;
    const timeoutId = window.setTimeout(onOpen, THREAD_FOLDER_HOVER_OPEN_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [onOpen, open, selected]);
  return null;
}

export default function WorkbenchThreadFolder({
  activeDragPayload = null,
  autoFocusName = false,
  attentionLabelsByThreadId = {},
  children,
  entries,
  folder,
  homeFolderKey,
  isDragActive,
  nowMs = Date.now(),
  onAutoFocusComplete,
  onMoveThread,
  onOpenChange,
  onRename,
  open,
  project,
  tooltip,
}: {
  activeDragPayload?: WorkbenchDragPayload | null;
  autoFocusName?: boolean;
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  children: ReactNode;
  entries: FolderEntry[];
  folder: WorkbenchThreadFolder;
  homeFolderKey?: string;
  isDragActive: boolean;
  nowMs?: number;
  onAutoFocusComplete?: () => void;
  onMoveThread: (sourceKey: string, destinationFolderId: string, beforeKey: string | null) => void;
  onOpenChange: (open: boolean) => void;
  onRename: (title: string) => Promise<string>;
  open: boolean;
  project?: WorkbenchProjectOption;
  tooltip: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const acceptedTitleRef = useRef(folder.title);
  const savingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const [draftTitle, setDraftTitle] = useState(folder.title);
  const [error, setError] = useState("");
  const [isDropTargetSelected, setIsDropTargetSelected] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const status = getFolderStatus(entries, attentionLabelsByThreadId);
  const latestActivityAt = Math.max(...entries.map((entry) => entry.activityAt));
  const latestTimestamp = new Date(latestActivityAt);
  onOpenChangeRef.current = onOpenChange;
  const openFromHover = useCallback(() => onOpenChangeRef.current(true), []);

  useEffect(() => {
    acceptedTitleRef.current = folder.title;
    if (!savingRef.current && document.activeElement !== inputRef.current) setDraftTitle(folder.title);
  }, [folder.title]);

  useEffect(() => {
    if (!autoFocusName) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onAutoFocusComplete?.();
  }, [autoFocusName, onAutoFocusComplete]);

  async function commit() {
    if (savingRef.current) return;
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setDraftTitle(acceptedTitleRef.current);
      setError("A folder name cannot be empty.");
      return;
    }
    if (nextTitle === acceptedTitleRef.current) {
      setDraftTitle(acceptedTitleRef.current);
      setError("");
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    setError("");
    try {
      const acceptedTitle = await onRename(nextTitle);
      acceptedTitleRef.current = acceptedTitle;
      setDraftTitle(acceptedTitle);
    } catch (renameError) {
      setDraftTitle(acceptedTitleRef.current);
      setError(boundedFolderError(renameError));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      skipBlurCommitRef.current = true;
      setDraftTitle(acceptedTitleRef.current);
      setError("");
      event.currentTarget.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  const folderKey = getWorkbenchThreadFolderKey(folder.folderId);
  const foreignHomeThreadDrag = Boolean(
    project
    && activeDragPayload?.type === "home-thread-row"
    && activeDragPayload.ownerProjectId !== project.id,
  );
  const StatusIcon = status.Icon;
  const titleInput = (
    <input
      ref={inputRef}
      aria-busy={isSaving || undefined}
      aria-invalid={Boolean(error) || undefined}
      aria-label="Folder name"
      autoComplete="off"
      className={`${workbenchThreadListLabelClassName} pointer-events-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-text [appearance:textfield] outline-none`}
      readOnly={isSaving}
      spellCheck={false}
      title={error || "Edit folder name"}
      value={draftTitle}
      onBlur={() => {
        if (skipBlurCommitRef.current) {
          skipBlurCommitRef.current = false;
          return;
        }
        void commit();
      }}
      onChange={(event) => {
        setDraftTitle(event.currentTarget.value);
        if (error) setError("");
      }}
      onKeyDown={handleTitleKeyDown}
      onKeyUp={(event) => event.stopPropagation()}
    />
  );
  const errorLabel = error ? <span className="max-w-32 shrink-0 truncate text-[0.68rem] text-danger" role="alert">{error}</span> : null;
  const fullSummary = (
    <WorkbenchThreadListFullRowContent
      action={errorLabel}
      eyebrow={project ? <WorkbenchProjectLabel project={project} variant="thread" /> : undefined}
      statusIcon={<StatusIcon className={`size-3.5 ${status.statusClassName}`} />}
      statusLabel={<span className={`truncate ${status.statusClassName}`}>{status.label}</span>}
      timestamp={<time dateTime={latestTimestamp.toISOString()} title={latestTimestamp.toLocaleString()}>{formatThreadRelativeTimestamp(latestActivityAt / 1000, nowMs)}</time>}
      title={(
        <span className="flex min-w-0 items-center gap-1.5">
          {open ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderClosedIcon className="size-3.5 shrink-0" />}
          {titleInput}
        </span>
      )}
    />
  );
  const summary = (
    <WorkbenchTooltip content={tooltip} enabled={!isDragActive} interactive>
      <div className="min-w-0">
        {project ? fullSummary : open ? (
          <div className="grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-[var(--thread-context-menu-row-padding-right,0.5rem)] pl-2 md:min-h-0">
            <FolderOpenIcon className="mr-1.5 size-3.5 shrink-0" />
            {titleInput}
            {errorLabel}
          </div>
        ) : (
          fullSummary
        )}
      </div>
    </WorkbenchTooltip>
  );

  return (
    <Draggable
      dropTargetIds={[WORKBENCH_THREAD_ORDER_DROP_TARGET_ID]}
      label={folder.title}
      payload={homeFolderKey && project
        ? { ownerProjectId: project.id, section: folder.section, sourceKey: homeFolderKey, type: "home-thread-folder" }
        : { section: folder.section, sourceKey: folderKey, type: "thread-folder" }}
    >
      {({ draggable, onDragStart, onPointerDown }) => (
        <div className={`group/thread-folder relative${foreignHomeThreadDrag ? " pointer-events-none" : ""}`} draggable={draggable} onDragStart={onDragStart} onPointerDown={onPointerDown}>
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 rounded-[0.8rem] bg-accent-soft transition-opacity duration-75 ease-out ${isDropTargetSelected ? "opacity-100" : "opacity-0"}`} />
          <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-20 size-full opacity-0 transition-opacity duration-75 ease-out group-hover/thread-folder:opacity-100 ${status.statusClassName}`}>
            <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity={status.strokeOpacity} strokeDasharray={status.dashed ? "6 4" : undefined} vectorEffect="non-scaling-stroke" />
          </svg>
          <DropTarget
            className={open
              ? "pointer-events-none absolute inset-x-0 top-0 z-30 h-11 md:h-8"
              : "pointer-events-none absolute inset-x-0 top-0 z-30 h-11"}
            dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
            enabled={(payload) => {
              if (homeFolderKey && project) {
                const identity = payload.type === "home-thread-row"
                  ? parseProjectQualifiedThreadDisplayKey(payload.sourceKey)
                  : null;
                return payload.type === "home-thread-row"
                  && payload.ownerProjectId === project.id
                  && payload.section === folder.section
                  && identity !== null
                  && !folder.threadKeys.includes(identity.threadKey);
              }
              return payload.type === "thread-row"
                && payload.section === folder.section
                && !folder.threadKeys.includes(payload.sourceKey);
            }}
            onDrop={(payload) => {
              if (homeFolderKey && payload.type === "home-thread-row") onMoveThread(payload.sourceKey, homeFolderKey, null);
              else if (payload.type === "thread-row") onMoveThread(payload.sourceKey, folder.folderId, null);
            }}
          >
            {({ selected }) => <FolderHoverOpenTarget onOpen={openFromHover} onSelectedChange={setIsDropTargetSelected} open={open} selected={selected} />}
          </DropTarget>
          <ThreadDisclosure
            chevronClassName="hidden"
            className={`relative z-10 rounded-[0.8rem] transition-[background-color,opacity] open:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]${folder.section === "snoozed" ? " opacity-50 hover:opacity-100 open:opacity-100" : ""}`}
            open={open}
            onToggle={(event) => onOpenChange(event.currentTarget.open)}
            summary={summary}
            summaryClassName="min-h-11 text-muted md:min-h-0"
          >
            {children}
          </ThreadDisclosure>
        </div>
      )}
    </Draggable>
  );
}
