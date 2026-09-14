/*
 * Exports:
 * - default WorkbenchFilePanel: mount one editable file panel with panel-scoped editor client surfaces.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { WorkbenchControls } from "workbench-shared/types";
import type { WorkbenchFilePanelClient, WorkbenchFilePanelClientOptions, WorkbenchFilePanelSnapshot } from "../../../workbench/WorkbenchFilePanelClient";
import type { WorkbenchEditorDomSurfaces } from "../../../workbench/workbench-dom";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE } from "../../../workbench/state/workbench-settings";
import WorkbenchIconButton from "../WorkbenchIconButton";
import WorkbenchZoomButton from "../WorkbenchZoomButton";
import {
  workbenchDiffGutterClassName,
  workbenchRevisionActionButtonClassName,
} from "../workbench-class-names";
import {
  WorkbenchDialog,
} from "../workbench-dialogs";
import { dialogButtonClassName } from "../workbench-dialog-styles";
import {
  BinIcon,
  PanelCloseIcon,
  PanelExpandIcon,
  PanelMinimizeIcon,
  SaveIcon,
} from "../workbench-icons";

interface WorkbenchFilePanelProps {
  clientOptions?: Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>;
  contained?: boolean;
  controls: WorkbenchControls | null;
  editorFontClassName: string;
  fontSizeRem: number;
  baseFontSizeRem?: number;
  hasSidebarRestoreInset?: boolean;
  isFocused: boolean;
  isMinimized?: boolean;
  isMinimizedVertical?: boolean;
  onFocus: () => void;
  onClose?: () => void;
  onHeaderPointerDragStart?: (event: PointerEvent<HTMLElement>) => void;
  onMinimizeToggle?: () => void;
  onPanelZoomDeltaChange?: (zoomDelta: number) => void;
  onSnapshotChange?: (snapshot: WorkbenchFilePanelSnapshot | null) => void;
  panelZoomDelta?: number;
  path: string;
  showManualFileActions?: boolean;
  spellCheck: boolean;
  titleLabel?: string;
}

export default function WorkbenchFilePanel ({
  baseFontSizeRem,
  clientOptions,
  contained = false,
  controls,
  editorFontClassName,
  fontSizeRem,
  hasSidebarRestoreInset = false,
  isFocused,
  isMinimized = false,
  isMinimizedVertical = false,
  onClose,
  onFocus,
  onHeaderPointerDragStart,
  onMinimizeToggle,
  onPanelZoomDeltaChange,
  onSnapshotChange,
  panelZoomDelta = 0,
  path,
  showManualFileActions = true,
  spellCheck,
  titleLabel,
}: WorkbenchFilePanelProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const customCaretRef = useRef<HTMLDivElement>(null);
  const diffGutterRef = useRef<HTMLDivElement>(null);
  const filePathLabelRef = useRef<HTMLParagraphElement>(null);
  const statusLineRef = useRef<HTMLParagraphElement>(null);
  const resetDraftButtonRef = useRef<HTMLButtonElement>(null);
  const saveFileButtonRef = useRef<HTMLButtonElement>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictDialogRef = useRef<HTMLDivElement>(null);
  const saveConflictSummaryRef = useRef<HTMLParagraphElement>(null);
  const saveConflictExpectedRef = useRef<HTMLParagraphElement>(null);
  const saveConflictActualRef = useRef<HTMLParagraphElement>(null);
  const saveConflictKeepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictReloadButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictOverwriteButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftDialogRef = useRef<HTMLDivElement>(null);
  const resetDraftCancelButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftHeadButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftSavedButtonRef = useRef<HTMLButtonElement>(null);
  const floatingToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const revisionHoverRejectButtonRef = useRef<HTMLButtonElement>(null);
  const clientRef = useRef<WorkbenchFilePanelClient | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchFilePanelSnapshot | null>(null);

  const panelIdSuffix = useMemo(() => path.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "file", [path]);

  useEffect(() => {
    if (
      !controls
      || !editorRef.current
      || !customCaretRef.current
      || !diffGutterRef.current
      || !filePathLabelRef.current
      || !statusLineRef.current
      || !resetDraftButtonRef.current
      || !saveFileButtonRef.current
      || !zoomButtonRef.current
      || !saveConflictDialogRef.current
      || !saveConflictSummaryRef.current
      || !saveConflictExpectedRef.current
      || !saveConflictActualRef.current
      || !saveConflictKeepEditingButtonRef.current
      || !saveConflictReloadButtonRef.current
      || !saveConflictOverwriteButtonRef.current
      || !resetDraftDialogRef.current
      || !resetDraftCancelButtonRef.current
      || !resetDraftHeadButtonRef.current
      || !resetDraftSavedButtonRef.current
      || !floatingToolbarRef.current
      || !revisionHoverToolbarRef.current
      || !revisionHoverAcceptButtonRef.current
      || !revisionHoverRejectButtonRef.current
    ) {
      return;
    }

    if (!("createFilePanelClient" in controls)) {
      return;
    }

    const panelControls = controls as WorkbenchControls & {
      createFilePanelClient: (surfaces: WorkbenchEditorDomSurfaces, options?: WorkbenchFilePanelProps["clientOptions"]) => WorkbenchFilePanelClient;
    };

    const surfaces: WorkbenchEditorDomSurfaces = {
      controls: {
        resetDraftButton: resetDraftButtonRef.current,
        saveFileButton: saveFileButtonRef.current,
        zoomButton: zoomButtonRef.current,
      },
      dialogs: {
        saveConflict: {
          actual: saveConflictActualRef.current,
          dialog: saveConflictDialogRef.current,
          expected: saveConflictExpectedRef.current,
          keepEditing: saveConflictKeepEditingButtonRef.current,
          overwrite: saveConflictOverwriteButtonRef.current,
          reload: saveConflictReloadButtonRef.current,
          summary: saveConflictSummaryRef.current,
        },
        resetDraft: {
          cancel: resetDraftCancelButtonRef.current,
          dialog: resetDraftDialogRef.current,
          resetToHead: resetDraftHeadButtonRef.current,
          resetToSaved: resetDraftSavedButtonRef.current,
        },
      },
      editor: {
        customCaret: customCaretRef.current,
        diffGutter: diffGutterRef.current,
        editor: editorRef.current,
      },
      statusDisplay: {
        filePathLabel: filePathLabelRef.current,
        statusLine: statusLineRef.current,
      },
      toolbars: {
        floating: floatingToolbarRef.current,
        revisionAccept: revisionHoverAcceptButtonRef.current,
        revisionHover: revisionHoverToolbarRef.current,
        revisionReject: revisionHoverRejectButtonRef.current,
      },
    };

    const client = panelControls.createFilePanelClient(surfaces, clientOptions);
    clientRef.current = client;
    client.setFontSize(fontSizeRem, { persist: false });
    const unsubscribe = client.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      onSnapshotChange?.(nextSnapshot);
    });
    setSnapshot(client.getSnapshot());
    onSnapshotChange?.(client.getSnapshot());
    void client.openFile(path);

    return () => {
      unsubscribe();
      client.dispose();
      clientRef.current = null;
      setSnapshot(null);
      onSnapshotChange?.(null);
    };
  }, [clientOptions, controls, onSnapshotChange, path]);

  useEffect(() => {
    clientRef.current?.setFontSize(fontSizeRem, { persist: false });
  }, [fontSizeRem]);

  const panelBaseFontSize = baseFontSizeRem ?? fontSizeRem;
  const usesPanelZoom = Boolean(onPanelZoomDeltaChange);
  const previewZoom = useCallback((value: number | null) => {
    clientRef.current?.previewFontSize(value === null ? null : usesPanelZoom ? panelBaseFontSize + value * 0.08 : value);
  }, [usesPanelZoom, panelBaseFontSize]);

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      !onHeaderPointerDragStart
      || (
        event.target instanceof HTMLElement
        && event.target.closest("button,a,input,textarea,select,[contenteditable='true']")
      )
    ) {
      return;
    }

    event.preventDefault();
    onHeaderPointerDragStart(event);
  }

  return (
    <div
      className="flex min-h-full min-w-0 flex-col"
      data-focused={isFocused ? "true" : "false"}
      onFocusCapture={onFocus}
      onPointerDownCapture={onFocus}
    >
      <header
        className={`sticky top-0 z-10 -mx-5 px-5 py-3 md:-mx-6 md:px-6${onHeaderPointerDragStart ? " cursor-grab active:cursor-grabbing" : ""}${hasSidebarRestoreInset ? " pl-28 md:pl-28" : ""}${isMinimizedVertical ? " flex h-full items-center justify-center" : ""}`}
        onPointerDown={handleHeaderPointerDown}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 md:mx-auto md:max-w-[58rem] bg-[linear-gradient(to_bottom,var(--shell-fade-bg)_calc(100%-var(--spacing)*6),transparent)] md:backdrop-blur-none"
        />
        <div className={`flex flex-col gap-2 md:flex-row md:items-start md:justify-between${isMinimizedVertical ? " rotate-90 whitespace-nowrap" : ""}`}>
          <div className="order-2 min-w-0 md:order-1">
            <p ref={filePathLabelRef} className="truncate text-base font-semibold leading-tight">
              {titleLabel ?? snapshot?.currentPath ?? path}
            </p>
            <p ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted" hidden={isMinimized}>
              Markdown files open as rich text. Save with Ctrl/Cmd+S.
            </p>
          </div>
          <div className="order-1 flex items-center justify-between gap-3 md:order-2 md:ml-auto md:flex-none md:justify-end">
            {onMinimizeToggle ? (
              <WorkbenchIconButton
                type="button"
                title={isMinimized ? "Expand panel" : "Minimize panel"}
                label={isMinimized ? "Expand panel" : "Minimize panel"}
                display="hover-border"
                onClick={onMinimizeToggle}
              >
                {isMinimized ? <PanelExpandIcon size={20} /> : <PanelMinimizeIcon size={20} />}
                <span className="sr-only">{isMinimized ? "Expand panel" : "Minimize panel"}</span>
              </WorkbenchIconButton>
            ) : null}
            <div className="flex items-center gap-1.5" hidden={isMinimized || !showManualFileActions}>
              <WorkbenchZoomButton
                ref={zoomButtonRef}
                label="Editor text size"
                disabled={isMinimized || !showManualFileActions || !snapshot}
                min={onPanelZoomDeltaChange ? Math.floor(Number(((MIN_EDITOR_FONT_SIZE - panelBaseFontSize) / 0.08).toFixed(6))) : MIN_EDITOR_FONT_SIZE}
                max={onPanelZoomDeltaChange ? Math.ceil(Number(((MAX_EDITOR_FONT_SIZE - panelBaseFontSize) / 0.08).toFixed(6))) : MAX_EDITOR_FONT_SIZE}
                step={onPanelZoomDeltaChange ? 1 : 0.08}
                value={onPanelZoomDeltaChange ? panelZoomDelta : snapshot?.fontSize ?? fontSizeRem}
                onPreview={previewZoom}
                format={value => `${Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, onPanelZoomDeltaChange ? panelBaseFontSize + value * 0.08 : value)).toFixed(2)}rem`}
                onChange={(value) => {
                  if (onPanelZoomDeltaChange) onPanelZoomDeltaChange(value);
                  else clientRef.current?.setFontSize(value);
                }}
              />
            </div>
            <div className="flex items-center gap-1.5" hidden={isMinimized || !showManualFileActions}>
              <WorkbenchIconButton
                ref={saveFileButtonRef}
                type="button"
                title="Save current file"
                label="Save current file"
                display="hover-border"
                data-invalid="false"
              >
                <SaveIcon size={20} />
                <span className="sr-only">Save current file</span>
              </WorkbenchIconButton>
              <WorkbenchIconButton
                ref={resetDraftButtonRef}
                type="button"
                title="Discard the current draft"
                label="Discard the current draft"
                display="hover-border"
              >
                <BinIcon size={20} />
                <span className="sr-only">Discard the current draft</span>
              </WorkbenchIconButton>
            </div>
            {onClose ? (
              <WorkbenchIconButton
                type="button"
                title="Close panel"
                label="Close panel"
                display="hover-border"
                onClick={onClose}
              >
                <PanelCloseIcon size={16} />
                <span className="sr-only">Close panel</span>
              </WorkbenchIconButton>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1" hidden={isMinimized}>
        <div className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem_minmax(0,1fr)] gap-[0.53rem] md:max-w-[calc(var(--container-content)+2.5rem)] md:grid-cols-[1.25rem_minmax(0,var(--container-content))] md:gap-3 -ml-5 md:ml-auto">
          <div
            ref={diffGutterRef}
            className={workbenchDiffGutterClassName}
            aria-hidden="true"
          />
          <div
            ref={editorRef}
            className={`editor-content ${contained ? "min-h-[18rem]" : "min-h-[calc(100vh-6rem)]"} pb-16 ${editorFontClassName} text-[1.08rem] leading-[1.72] whitespace-normal outline-none`}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spellCheck}
            data-placeholder="Select a markdown file to start editing."
          />
          <div
            ref={customCaretRef}
            className="editor-custom-caret"
            aria-hidden="true"
            hidden
          />
        </div>
      </div>

      <WorkbenchDialog
        id={`save-conflict-dialog-${panelIdSuffix}`}
        dialogRef={saveConflictDialogRef}
        titleId={`save-conflict-title-${panelIdSuffix}`}
        summaryId={`save-conflict-summary-${panelIdSuffix}`}
        eyebrow="Write conflict"
        title="This file changed on disk"
        actions={
          <>
            <button ref={saveConflictKeepEditingButtonRef} type="button" className={dialogButtonClassName}>Keep editing</button>
            <button ref={saveConflictReloadButtonRef} type="button" className={dialogButtonClassName}>Reload from disk</button>
            <button ref={saveConflictOverwriteButtonRef} type="button" className={dialogButtonClassName}>Overwrite anyway</button>
          </>
        }
      >
        <>
          <p id={`save-conflict-summary-${panelIdSuffix}`} ref={saveConflictSummaryRef} className="mt-3 text-sm leading-6 text-fg/muted">
            Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.
          </p>
          <p ref={saveConflictExpectedRef} className="mt-3 text-[0.84rem] tracking-[0.02em] text-fg/muted" />
          <p ref={saveConflictActualRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted" />
        </>
      </WorkbenchDialog>

      <WorkbenchDialog
        id={`reset-draft-dialog-${panelIdSuffix}`}
        dialogRef={resetDraftDialogRef}
        titleId={`reset-draft-title-${panelIdSuffix}`}
        summaryId={`reset-draft-summary-${panelIdSuffix}`}
        eyebrow="Discard draft"
        title="Reset this draft?"
        actions={
          <>
            <button ref={resetDraftCancelButtonRef} type="button" className={dialogButtonClassName}>Cancel</button>
            <button ref={resetDraftHeadButtonRef} type="button" className={dialogButtonClassName}>Reset to HEAD</button>
            <button ref={resetDraftSavedButtonRef} type="button" className={dialogButtonClassName}>Reset to saved</button>
          </>
        }
      >
        <p id={`reset-draft-summary-${panelIdSuffix}`} className="mt-3 text-sm leading-6 text-fg/muted">
          Reset to saved discards the current draft and reloads the file from disk. Reset to HEAD overwrites the file on disk with the current git HEAD version, then reloads it here.
        </p>
      </WorkbenchDialog>

      <div ref={floatingToolbarRef} className="pointer-events-none fixed left-0 top-0 z-30 hidden" hidden />
      <div ref={revisionHoverToolbarRef} className="pointer-events-none fixed left-0 top-0 z-30 hidden" hidden>
        <button ref={revisionHoverAcceptButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Accept</button>
        <button ref={revisionHoverRejectButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Reject</button>
      </div>
    </div>
  );
}
