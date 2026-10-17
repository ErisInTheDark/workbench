/*
 * Exports:
 * - default WorkbenchFilePanel: mount one editable file panel with panel-scoped editor client surfaces; mosaic panels get a
 *   titled header, the main pane a floating save and discard control shown while there is local work.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import createFilePanelClient, { type WorkbenchFilePanelClient, type WorkbenchFilePanelSnapshot } from "../../../workbench/WorkbenchFilePanelClient";
import useFileDocument from "../../../workbench/file/use-file-document";
import { WORKBENCH_STICKY_CHROME_ATTRIBUTE, type WorkbenchEditorDomSurfaces } from "../../../workbench/workbench-dom";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE } from "../../../workbench/state/workbench-settings";
import IconButton from "../../ui/IconButton";
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
  contained?: boolean;
  editorFontClassName: string;
  fontSizeRem: number;
  baseFontSizeRem?: number;
  sidebarToggleInset?: "collapsed" | "expanded";
  isFocused: boolean;
  isMinimized?: boolean;
  isMinimizedVertical?: boolean;
  location: ProjectLocationReference | null;
  onFocus: () => void;
  onClose?: () => void;
  onHeaderPointerDragStart?: (event: PointerEvent<HTMLElement>) => void;
  onMinimizeToggle?: () => void;
  onPanelZoomDeltaChange?: (zoomDelta: number) => void;
  panelZoomDelta?: number;
  path: string;
  showManualFileActions?: boolean;
  spellCheck: boolean;
  titleLabel?: string;
}

export default function WorkbenchFilePanel ({
  baseFontSizeRem,
  contained = false,
  editorFontClassName,
  fontSizeRem,
  sidebarToggleInset,
  isFocused,
  isMinimized = false,
  isMinimizedVertical = false,
  location,
  onClose,
  onFocus,
  onHeaderPointerDragStart,
  onMinimizeToggle,
  onPanelZoomDeltaChange,
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
  const file = useFileDocument(location, path);

  const panelIdSuffix = useMemo(() => path.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "file", [path]);

  useEffect(() => {
    if (
      !file.document
      || !editorRef.current
      || !customCaretRef.current
      || !diffGutterRef.current
      || !filePathLabelRef.current
      || !statusLineRef.current
      || !resetDraftButtonRef.current
      || !saveFileButtonRef.current
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

    const surfaces: WorkbenchEditorDomSurfaces = {
      controls: {
        resetDraftButton: resetDraftButtonRef.current,
        saveFileButton: saveFileButtonRef.current,
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

    const client = createFilePanelClient({ document: file.document, surfaces });
    clientRef.current = client;
    client.setFontSize(fontSizeRem, { persist: false });
    const unsubscribe = client.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });
    setSnapshot(client.getSnapshot());

    return () => {
      unsubscribe();
      client.dispose();
      clientRef.current = null;
      setSnapshot(null);
    };
  }, [file.document]);

  useEffect(() => {
    clientRef.current?.acceptObservation(file.snapshot);
  }, [file.document, file.snapshot]);

  useEffect(() => {
    clientRef.current?.setFontSize(fontSizeRem, { persist: false });
  }, [fontSizeRem]);

  const panelBaseFontSize = baseFontSizeRem ?? fontSizeRem;
  const usesPanelZoom = Boolean(onPanelZoomDeltaChange);
  const previewZoom = useCallback((value: number | null) => {
    clientRef.current?.previewFontSize(value === null ? null : usesPanelZoom ? panelBaseFontSize + value * 0.08 : value);
  }, [usesPanelZoom, panelBaseFontSize]);

  const hasLocalWork = Boolean(snapshot?.dirty || snapshot?.hasSaveIssue || snapshot?.hasPendingWriteConflict);
  const saveButton = (
    <IconButton ref={saveFileButtonRef} type="button" title="Save current file" label="Save current file" display="hover-border" data-invalid="false">
      <SaveIcon size={20} />
      <span className="sr-only">Save current file</span>
    </IconButton>
  );
  const discardButton = (
    <IconButton ref={resetDraftButtonRef} type="button" title="Discard the current draft" label="Discard the current draft" display="hover-border">
      <BinIcon size={20} />
      <span className="sr-only">Discard the current draft</span>
    </IconButton>
  );

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
      {file.snapshot.failure ? <p role="alert">{file.snapshot.failure}</p> : null}
      {!file.snapshot.data && file.snapshot.phase === "pending" ? <p role="status">Loading file...</p> : null}
      {file.snapshot.data && file.snapshot.phase !== "current" && !file.snapshot.failure
        ? <p role="status">Waiting for current disk data...</p> : null}
      {contained ? (
        <header
          className={`
            sticky top-0 z-10 -mx-5 py-3 md:-mx-6
            ${sidebarToggleInset === "collapsed" ? "pl-32 pr-5 md:pl-32 md:pr-6" : sidebarToggleInset === "expanded" ? "pl-19 pr-5 md:pl-19 md:pr-6" : "px-5 md:px-6"}
            ${onHeaderPointerDragStart ? "cursor-grab active:cursor-grabbing" : ""}
            ${isMinimizedVertical ? "flex h-full items-center justify-center" : ""}
          `}
          {...{ [WORKBENCH_STICKY_CHROME_ATTRIBUTE]: "" }}
          onPointerDown={handleHeaderPointerDown}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to bottom, var(--app-bg-solid) calc(100% - var(--spacing) * 6), transparent)] md:backdrop-blur-none"
          />
          <div className={`flex flex-col gap-2 md:flex-row md:items-start md:justify-between ${isMinimizedVertical ? "rotate-90 whitespace-nowrap" : ""}`}>
            <div className="order-2 min-w-0 md:order-1">
              <p ref={filePathLabelRef} className="truncate text-base font-semibold leading-tight">
                {titleLabel ?? snapshot?.currentPath ?? path}
              </p>
              <p ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted" hidden={isMinimized} />
            </div>
            <div className="order-1 flex items-center justify-between gap-3 md:order-2 md:ml-auto md:flex-none md:justify-end">
              {onMinimizeToggle ? (
                <IconButton
                  type="button"
                  title={isMinimized ? "Expand panel" : "Minimize panel"}
                  label={isMinimized ? "Expand panel" : "Minimize panel"}
                  display="hover-border"
                  onClick={onMinimizeToggle}
                >
                  {isMinimized ? <PanelExpandIcon size={20} /> : <PanelMinimizeIcon size={20} />}
                  <span className="sr-only">{isMinimized ? "Expand panel" : "Minimize panel"}</span>
                </IconButton>
              ) : null}
              {onPanelZoomDeltaChange ? (
                <div className="flex items-center gap-1.5" hidden={isMinimized || !showManualFileActions}>
                  <WorkbenchZoomButton
                    label="Editor text size"
                    disabled={isMinimized || !showManualFileActions || !snapshot}
                    min={Math.floor(Number(((MIN_EDITOR_FONT_SIZE - panelBaseFontSize) / 0.08).toFixed(6)))}
                    max={Math.ceil(Number(((MAX_EDITOR_FONT_SIZE - panelBaseFontSize) / 0.08).toFixed(6)))}
                    step={1}
                    value={panelZoomDelta}
                    onPreview={previewZoom}
                    format={value => `${Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, panelBaseFontSize + value * 0.08)).toFixed(2)}rem`}
                    onChange={onPanelZoomDeltaChange}
                  />
                </div>
              ) : null}
              <div className="flex items-center gap-1.5" hidden={isMinimized || !showManualFileActions}>
                {saveButton}
                {discardButton}
              </div>
              {onClose ? (
                <IconButton
                  type="button"
                  title="Close panel"
                  label="Close panel"
                  display="hover-border"
                  onClick={onClose}
                >
                  <PanelCloseIcon size={16} />
                  <span className="sr-only">Close panel</span>
                </IconButton>
              ) : null}
            </div>
          </div>
        </header>
      ) : (
        // In the main pane the shell tab names the file; save and discard float in reach only while there is work to keep.
        <div
          className={`
            fixed right-4 bottom-[calc(1rem+var(--workbench-safe-area-bottom,0px))] z-30 flex max-w-[calc(100vw-2rem)]
            items-center gap-1 rounded-full border border-fg-alpha/10 py-1 pr-1 pl-3.5
            bg-[color-mix(in srgb, var(--app-bg-solid) 90%, transparent)] backdrop-blur-sm
            transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none md:right-6
            ${hasLocalWork ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}
          `}
          inert={!hasLocalWork}
        >
          <p ref={filePathLabelRef} className="sr-only" />
          <p ref={statusLineRef} className="m-0 min-w-0 truncate text-[0.84rem] text-fg/muted" />
          {saveButton}
          {discardButton}
        </div>
      )}

      <div className="relative min-h-0 flex-1" hidden={isMinimized}>
        <div className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem minmax(0, 1fr)] gap-[0.53rem] md:max-w-[calc(var(--container-content)+2.5rem)] md:grid-cols-[1.25rem minmax(0, var(--container-content))] md:gap-3 -ml-5 md:ml-auto">
          <div
            ref={diffGutterRef}
            className={workbenchDiffGutterClassName}
            aria-hidden="true"
          />
          <div
            ref={editorRef}
            className={`
              editor-content ${contained ? "min-h-[18rem]" : "min-h-[calc(100vh-6rem)]"}
              pb-16 ${editorFontClassName} text-[1.08rem] leading-[1.72] whitespace-normal outline-none
              data-[custom-caret-visible=true]:caret-transparent
              empty:before:(text-fg/muted content-[attr(data-placeholder)])
              [& :is(p, blockquote, ul, ol, pre, h1, h2, h3, h4, h5, h6)]:(m-0 mb-4 text-justify)
              [& :is(h1, h2, h3, h4, h5, h6)]:(font-sans font-semibold leading-[1.15])
              [& h1]:text-[2.05em] [& h2]:text-[1.55em] [& h3]:text-[1.25em]
              [& :is(ul, ol)]:(list-outside pl-[1.3rem])
              [& ul]:list-disc [& ul ul]:list-[circle] [& ul ul ul]:list-[square]
              [& ol]:list-decimal
              [& blockquote]:text-fg/muted
              [& a]:(text-inherit decoration-accent decoration-[0.08em])
              [& code]:(font-mono text-[0.94em] bg-fg/7 rounded-[0.35rem] px-[0.34em] py-[0.08em])
              [& pre]:(overflow-x-auto whitespace-pre-wrap)
              [& pre[data-language]:not([data-language=""])]:before:(
                content-[attr(data-language)] block
                -mx-[0.15rem] -mt-[0.2rem] mb-[0.65rem]
                border-b border-fg-alpha/8 pb-[0.45rem]
                font-mono text-[0.72em] leading-none text-fg/muted
              )
              [& pre code]:(block bg-transparent rounded-none p-0)
              [& :is(ins, del)]:(rounded-[0.2em] text-inherit -mx-[0.04em] px-[0.08em])
              [& ins]:(bg-success/16 [font-weight:inherit] no-underline)
              [& ins[data-revision-hover-active=true]]:bg-success/24
              [& del]:(bg-danger/16 decoration-current decoration-[0.08em])
              [& del[data-revision-hover-active=true]]:bg-danger/24
              [& p:has(+ :where(br, [data-single-break=true]) + [data-block-comment=true])]:mb-0
              [& p:has(+ [data-block-comment=true])]:mb-[-0.1rem]
              [& [data-block-comment=true] + :where(br, [data-single-break=true])]:mb-0
              [& :is([data-block-comment=true], [data-inline-comment=true])]:(
                bg-fg/6 text-fg/60
              )
              [& [data-block-comment=true]]:(
                rounded-[0.45rem] px-3 py-[0.45rem] my-0 -mx-3
                whitespace-pre-wrap font-sans text-[0.85em]
              )
              [& [data-inline-comment=true]]:(rounded-[0.35rem] px-[0.34em] py-[0.08em])
              [& :is([data-block-comment=true], [data-inline-comment=true])[data-revision-hover-active=true]]:bg-fg/12
              [& li > details]:block
              [& li > details > summary]:(flex [list-style: none] cursor-pointer)
              [& li > details > summary > span]:cursor-text
              [& li > details > summary]:after:(
                content-[''] inline-block size-[0.36em] mx-[0.42em] shrink-0 self-center
                border-r-[0.1em] border-b-[0.1em] border-current rotate-[-45deg]
                transition-transform duration-[160ms] ease-[ease]
              )
              [& li > details[open] > summary]:after:rotate-45
            `}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spellCheck}
            data-placeholder="Select a markdown file to start editing."
          />
          <div
            ref={customCaretRef}
            className="
              pointer-events-none absolute top-0 left-0 z-20 min-h-[1em] w-[2px] origin-center rounded-full
              bg-text [box-shadow: 0 0 0.35rem color-mix(in srgb, var(--shadow) 28%, transparent)]
              transform-[translate3d(0,0,0)] animate-blink
              data-[caret-kind=code]:bg-[color-mix(in srgb, var(--text) 56%, var(--bg) 44%)]
              data-[caret-kind=comment]:bg-[color-mix(in srgb, var(--text) 42%, var(--bg) 58%)]
              data-[caret-kind=del]:bg-danger data-[caret-kind=ins]:bg-success
              data-[caret-bold=true]:w-[2.8px]
              data-[caret-italic=true]:transform-[skew(-10deg)]
              data-[caret-bold=true]:data-[caret-italic=true]:transform-[skew(-10deg) scaleX(1.22)]
            "
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
