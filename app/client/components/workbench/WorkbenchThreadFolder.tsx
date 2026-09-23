/*
 * Exports:
 * - default WorkbenchThreadFolder: own one editable, status-toned sidebar folder disclosure with tooltip, drag, drop, and hover-open lifecycle.
 * - Local helpers: bound rename errors, rank folder lifecycle tone, and open a selected drag target after one owned delay.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import {
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
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
import { CompletedThreadIcon, DraftThreadIcon, FolderClosedIcon, FolderOpenIcon, NeedsAttentionThreadIcon, ProposedCommitThreadIcon, StoppedThreadIcon, WorkingThreadIcon, type IconProps } from "./workbench-icons";
import WorkbenchTooltip from "./WorkbenchTooltip";
import Draggable from "./drag/Draggable";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadListFullRowContent from "./WorkbenchThreadListFullRowContent";

const THREAD_FOLDER_HOVER_OPEN_DELAY_MS = 1_000;

function boundedFolderError(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to update the folder name.").slice(0, 160);
}

type FolderEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> | WorkbenchPinnedThreadSummaryEntry;
type FolderStatusIcon = ComponentType<IconProps>;

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
  if (entry.entryKind === "draft") return { dashed: true, Icon: DraftThreadIcon as FolderStatusIcon, label: "Draft", statusClassName: "text-fg/muted", strokeOpacity: 0.24 };
  const waiting = Boolean(entry.waitingFor) && !(entry.metadata.snoozed && entry.lifecycle.kind === "needsAttention");
  const proposed = !waiting && entry.lifecycle.kind === "completed" && Boolean(entry.gitArc?.proposals.some(({ status }) => status === "proposed"));
  const tone: WorkbenchThreadStatusTone = waiting
    ? "waiting"
    : entry.lifecycle.kind === "needsAttention"
    ? getNeedsAttentionThreadStatusTone(!entry.metadata.snoozed)
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

function FolderHoverOpenTarget({ onOpen, open, selected }: { onOpen: () => void; open: boolean; selected: boolean }) {
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
  canPrependThread,
  children,
  entries,
  folder,
  homeFolderKey,
  isDragActive,
  nowMs = Date.now(),
  onAutoFocusComplete,
  onOpenChange,
  onPrependThread,
  onRename,
  open,
  project,
  tooltip,
}: {
  activeDragPayload?: WorkbenchDragPayload | null;
  autoFocusName?: boolean;
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  canPrependThread?: (payload: WorkbenchThreadRowDragPayload) => boolean;
  children: ReactNode;
  entries: FolderEntry[];
  folder: WorkbenchThreadFolder;
  homeFolderKey?: string;
  isDragActive: boolean;
  nowMs?: number;
  onAutoFocusComplete?: () => void;
  onOpenChange: (open: boolean) => void;
  onPrependThread?: (payload: WorkbenchThreadRowDragPayload) => void;
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
  const canPrependActiveThread = Boolean(
    isWorkbenchThreadRowDragPayload(activeDragPayload)
    && canPrependThread?.(activeDragPayload),
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
      statusIcon={<StatusIcon className={status.statusClassName} size={14} />}
      statusLabel={<span className={`truncate ${status.statusClassName}`}>{status.label}</span>}
      timestamp={<time dateTime={latestTimestamp.toISOString()} title={latestTimestamp.toLocaleString()}>{formatThreadRelativeTimestamp(latestActivityAt / 1000, nowMs)}</time>}
      title={(
        <span className="flex min-w-0 items-center gap-1.5">
          {open ? <FolderOpenIcon className="shrink-0" size={14} /> : <FolderClosedIcon className="shrink-0" size={14} />}
          {titleInput}
        </span>
      )}
    />
  );
  const summary = (
    <WorkbenchTooltip content={tooltip} enabled={!isDragActive} interactive>
      <div className="min-w-0">
        {project ? fullSummary : open ? (
          <div className="grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-2 pl-2 md:min-h-0">
            <FolderOpenIcon className="mr-1.5 shrink-0" size={14} />
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
          <FolderHoverOpenTarget onOpen={openFromHover} open={open} selected={isDropTargetSelected} />
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 rounded-[0.8rem] bg-accent-soft transition-opacity duration-75 ease-out ${isDropTargetSelected ? "opacity-100" : "opacity-0"}`} />
          <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-20 size-full opacity-0 transition-opacity duration-75 ease-out group-hover/thread-folder:opacity-100 ${status.statusClassName}`}>
            <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity={status.strokeOpacity} strokeDasharray={status.dashed ? "6 4" : undefined} vectorEffect="non-scaling-stroke" />
          </svg>
          <WorkbenchThreadDragTargets
            activePayload={activeDragPayload}
            folderLabel={`add to ${folder.title}`}
            folderTargetClassName={open
              ? "pointer-events-none absolute inset-x-0 top-0 z-30 h-11 md:h-8"
              : "pointer-events-none absolute inset-x-0 top-0 z-30 h-11"}
            hoverScope="folder"
            onFolderDrop={canPrependActiveThread && onPrependThread ? onPrependThread : undefined}
            onFolderSelectedChange={setIsDropTargetSelected}
            targetIdentity={null}
            targetProjectId={project?.id}
            targetTitle={folder.title}
          />
          <ThreadDisclosure
            chevronClassName="hidden"
            className={`relative z-10 rounded-[0.8rem] transition-[background-color,opacity] open:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]${folder.section === "snoozed" ? " opacity-50 hover:opacity-100 open:opacity-100" : ""}`}
            open={open}
            onToggle={(event) => onOpenChange(event.currentTarget.open)}
            summary={summary}
            summaryClassName="min-h-11 text-fg/muted md:min-h-0"
          >
            {children}
          </ThreadDisclosure>
        </div>
      )}
    </Draggable>
  );
}
