/*
 * Exports:
 * - default WorkbenchFilePanel: mount one editable file panel with panel-scoped editor client surfaces: a persistent
 *   markdown toolbar, the editor with its comment margin and suggestion originals, and save/discard controls (a
 *   titled header in mosaic panels, a floating pill in the main pane while there is local work).
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import createFilePanelClient, { type WorkbenchFilePanelClient, type WorkbenchFilePanelSnapshot } from "../../../workbench/WorkbenchFilePanelClient";
import useFileDocument from "../../../workbench/file/use-file-document";
import { WORKBENCH_STICKY_CHROME_ATTRIBUTE, type WorkbenchEditorDomSurfaces } from "../../../workbench/workbench-dom";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, type WorkbenchEditorFontFamily } from "../../../workbench/state/workbench-settings";
import { useSettings } from "../use-settings";
import type MobileShellHeaderVisibilityController from "../MobileShellHeaderVisibilityController";
import IconButton from "../../ui/IconButton";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";
import WorkbenchZoomButton from "../WorkbenchZoomButton";
import MarkdownCommentMargin from "../markdown-editor/MarkdownCommentMargin";
import MarkdownEditorToolbar from "../markdown-editor/MarkdownEditorToolbar";
import useEditorMarginLayout from "../markdown-editor/use-editor-margin-layout";
import {
  workbenchDiffGutterClassName,
  workbenchRevisionActionButtonClassName,
  workbenchRevisionHoverToolbarClassName,
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

const EDITOR_FONT_CLASS_NAMES: Record<WorkbenchEditorFontFamily, string> = {
  mono: "font-mono", sans: "font-sans", serif: "font-serif",
};

/** Typography of rendered markdown, shared by the editor and the suggestion originals shown beside it. */
const markdownProseClassName = `
  text-[1.08rem] leading-[1.72] whitespace-normal [text-underline-offset:0.32em]
  [& :is(p, blockquote, ul, ol, pre, h1, h2, h3, h4, h5, h6)]:(m-0 mb-4 text-justify)
  [& :is(h1, h2, h3, h4, h5, h6)]:(font-sans font-semibold leading-[1.15])
  [& h1]:text-[2.05em] [& h2]:text-[1.55em] [& h3]:text-[1.25em]
  [& :is(ul, ol)]:(list-outside pl-[1.3rem])
  [& ul]:list-disc [& ul ul]:list-[circle] [& ul ul ul]:list-[square]
  [& ol]:list-decimal
  [& blockquote]:text-fg/muted
  [& hr]:(my-8 [margin-inline:10%] [border-color:color-mix(in srgb, var(--text), var(--app-bg-solid) 70%)])
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
  [& mark]:(rounded-[0.15em] bg-[color-mix(in srgb, var(--attention) 6%, transparent)] text-inherit -mx-[0.04em] px-[0.04em])
  [& li > details]:block
  [& li > details > summary]:(flex [list-style: none] cursor-pointer)
  [& li > details > summary > span]:cursor-text
  [& li > details > summary]:after:(
    content-[''] inline-block size-[0.36em] mx-[0.42em] shrink-0 self-center
    border-r-[0.1em] border-b-[0.1em] border-current rotate-[-45deg]
    transition-transform duration-[160ms] ease-[ease]
  )
  [& li > details[open] > summary]:after:rotate-45
`;

interface WorkbenchFilePanelProps {
  contained?: boolean;
  fontSizePreview?: number | null;
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
  /** The main pane's shell header slides away on mobile scroll; the toolbar below it slides with it. */
  shellHeaderVisibility?: MobileShellHeaderVisibilityController;
  showManualFileActions?: boolean;
  titleLabel?: string;
}

const noSubscription = () => () => {};
const noThreads = () => 0;
const alwaysVisible = () => true;
/** The toolbar tucks under the chrome's bottom padding, which is only its fade. */
const CHROME_FADE_OVERLAP_PX = 12;

/** Sticky chrome that sits above an element in its scroll container, such as the main pane's tab strip. */
function findStickyChromeAbove(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling instanceof HTMLElement && sibling.hasAttribute(WORKBENCH_STICKY_CHROME_ATTRIBUTE)) return sibling;
    }
  }
  return null;
}

/** The main pane's toolbar sticks just below the shell's sticky tab strip. */
function useStickyTopBelowChrome(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    const chrome = enabled && element ? findStickyChromeAbove(element) : null;
    if (!chrome) return;
    const update = () => setTop(Math.max(0, chrome.offsetHeight - CHROME_FADE_OVERLAP_PX));
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(chrome);
    return () => observer?.disconnect();
  }, [enabled]);

  return { ref, top };
}

export default function WorkbenchFilePanel ({
  fontSizePreview,
  contained = false,
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
  shellHeaderVisibility,
  showManualFileActions = true,
  titleLabel,
}: WorkbenchFilePanelProps) {
  const shellHeaderVisible = useSyncExternalStore(
    shellHeaderVisibility?.subscribe ?? noSubscription,
    shellHeaderVisibility?.getVisible ?? alwaysVisible,
    alwaysVisible,
  );
  const settings = useSettings.forLocation(location);
  const editorFontClassName = EDITOR_FONT_CLASS_NAMES[settings.get("editorFontFamily")];
  const spellCheck = settings.get("editorSpellCheck");
  const panelBaseFontSize = fontSizePreview ?? settings.get("editorFontSize");
  const fontSizeRem = Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE,
    Number((panelBaseFontSize + panelZoomDelta * 0.08).toFixed(2))));
  const editorShellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const customCaretRef = useRef<HTMLDivElement>(null);
  const diffGutterRef = useRef<HTMLDivElement>(null);
  const reviewLayerRef = useRef<HTMLDivElement>(null);
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
  const revisionHoverToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const revisionHoverRejectButtonRef = useRef<HTMLButtonElement>(null);
  const [client, setClient] = useState<WorkbenchFilePanelClient | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchFilePanelSnapshot | null>(null);
  const file = useFileDocument(location, path);
  const loading = !file.snapshot.data && !file.snapshot.failure;
  const stickyToolbar = useStickyTopBelowChrome(!contained && !loading);

  const panelIdSuffix = useMemo(() => path.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "file", [path]);

  useEffect(() => {
    if (
      !file.document
      || !editorRef.current
      || !customCaretRef.current
      || !diffGutterRef.current
      || !reviewLayerRef.current
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
        reviewLayer: reviewLayerRef.current,
      },
      statusDisplay: {
        filePathLabel: filePathLabelRef.current,
        statusLine: statusLineRef.current,
      },
      toolbars: {
        revisionAccept: revisionHoverAcceptButtonRef.current,
        revisionHover: revisionHoverToolbarRef.current,
        revisionReject: revisionHoverRejectButtonRef.current,
      },
    };

    const nextClient = createFilePanelClient({ document: file.document, surfaces });
    setClient(nextClient);
    nextClient.setFontSize(fontSizeRem, { persist: false });
    const unsubscribe = nextClient.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });
    setSnapshot(nextClient.getSnapshot());

    return () => {
      unsubscribe();
      nextClient.dispose();
      setClient(null);
      setSnapshot(null);
    };
  }, [file.document]);

  useEffect(() => {
    client?.acceptObservation(file.snapshot);
  }, [client, file.snapshot]);

  useEffect(() => {
    client?.setFontSize(fontSizeRem, { persist: false });
  }, [client, fontSizeRem]);

  const threadCount = useSyncExternalStore(
    client?.comments.subscribe ?? noSubscription,
    () => (client?.comments.getSnapshot().threads.length ?? 0) + (client?.comments.getSnapshot().draft ? 1 : 0),
    noThreads,
  );
  const marginLayout = useEditorMarginLayout(editorShellRef, editorRef, threadCount > 0);

  useEffect(() => {
    client?.setSuggestionLayout(marginLayout.suggestion);
  }, [client, marginLayout.suggestion]);

  const usesPanelZoom = Boolean(onPanelZoomDeltaChange);
  const previewZoom = useCallback((value: number | null) => {
    client?.previewFontSize(value === null ? null : usesPanelZoom ? panelBaseFontSize + value * 0.08 : value);
  }, [client, usesPanelZoom, panelBaseFontSize]);

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
  /** Header rows own their inset, so the toolbar can scroll edge to edge with its controls still inset. */
  const headerInsetClassName = sidebarToggleInset === "collapsed" ? "pl-32 pr-5 md:pr-6"
    : sidebarToggleInset === "expanded" ? "pl-19 pr-5 md:pr-6"
      : "px-5 md:px-6";

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      !onHeaderPointerDragStart
      || (
        event.target instanceof HTMLElement
        && event.target.closest("button,a,input,textarea,select,[role='toolbar'],[contenteditable='true']")
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
      {file.snapshot.data && file.snapshot.phase !== "current" && !file.snapshot.failure
        ? <p role="status">Waiting for current disk data...</p> : null}
      {contained ? (
        <header
          className={`
            sticky top-0 z-10 -mx-5 py-3 md:-mx-6
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
          <div className={`flex flex-col gap-2 md:flex-row md:items-start md:justify-between ${headerInsetClassName} ${isMinimizedVertical ? "rotate-90 whitespace-nowrap" : ""}`}>
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
          {isMinimized || loading ? null : <MarkdownEditorToolbar client={client} className={`mt-1.5 ${headerInsetClassName}`} />}
        </header>
      ) : (
        <>
          {loading ? null : <div
            ref={stickyToolbar.ref}
            className={`
              sticky z-[9] -mx-5 md:-mx-6
              transition-[top,translate,opacity] duration-200 ease-out motion-reduce:transition-none
              ${shellHeaderVisible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-[calc(100%+1.5rem)] opacity-0"}
            `}
            style={{ top: shellHeaderVisible ? stickyToolbar.top : 0 }}
            inert={!shellHeaderVisible}
            {...{ [WORKBENCH_STICKY_CHROME_ATTRIBUTE]: "" }}
          >
            {/* Reaches up under the shell header, whose own fade would otherwise let scrolled text show between the two, and fades out below like it. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-6 -bottom-6 -z-10 bg-[linear-gradient(to bottom, var(--app-bg-solid) calc(100% - var(--spacing) * 6), transparent)]"
            />
            {/* Spans the pane edge to edge; the toolbar's own padding lines its controls up with the text column. */}
            <div
              className="mx-auto md:max-w-[calc(var(--container-content)+5.5rem)]"
              style={marginLayout.shellOffset === null ? undefined : { marginLeft: marginLayout.shellOffset, marginRight: 0 }}
            >
              <MarkdownEditorToolbar client={client} className="px-5 md:pr-6 md:pl-[3.5rem]" />
            </div>
          </div>}
          {/* In the main pane the shell tab names the file; save and discard float in reach only while there is work to keep. */}
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
        </>
      )}

      {loading && !isMinimized ? <WorkbenchLoadingSpinner label="Loading file" /> : null}
      {/* The editor mounts while loading, hidden, so its client is ready the moment content arrives. */}
      <div className="relative min-h-0 flex-1 pt-3" hidden={isMinimized || loading}>
        <div
          ref={editorShellRef}
          className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem minmax(0, 1fr)] gap-[0.53rem] md:max-w-[calc(var(--container-content)+2.5rem)] md:grid-cols-[1.25rem minmax(0, var(--container-content))] md:gap-3 -ml-5 md:ml-auto"
          style={marginLayout.shellOffset === null ? undefined : { marginLeft: marginLayout.shellOffset, marginRight: 0 }}
        >
          <div
            ref={diffGutterRef}
            className={workbenchDiffGutterClassName}
            aria-hidden="true"
          />
          <div
            ref={editorRef}
            className={`
              editor-content ${contained ? "min-h-[18rem]" : "min-h-[calc(100vh-6rem)]"}
              pb-16 ${editorFontClassName} ${markdownProseClassName} outline-none
              data-[custom-caret-visible=true]:caret-transparent
              empty:before:(text-fg/muted content-[attr(data-placeholder)])
              [& [data-comment-thread]]:(select-none)
              [& aside[data-comment-thread]]:(block h-0 m-0 overflow-hidden)
              [& span[data-comment-thread]:not([data-comment-anchored])]:(
                inline-block size-[0.62em] mx-[0.18em] rounded-full align-[0.08em] cursor-pointer
                bg-[color-mix(in srgb, var(--attention) 75%, transparent)]
              )
              [& > [data-suggestion]]:(relative)
              [&[data-suggest-split] > [data-suggestion]]:(
                ml-[var(--suggest-new-offset)] w-[var(--suggest-col-width)] max-w-none
              )
              [& > [data-suggestion-empty]]:after:(
                content-['Suggested_deletion'] absolute left-0 top-0 pointer-events-none
                font-sans text-[0.82em] italic text-fg/45
              )
            `}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spellCheck}
            data-placeholder="Select a markdown file to start editing."
          />
          <div
            ref={reviewLayerRef}
            aria-label="Suggestions"
            className={`
              pointer-events-none absolute inset-0 ${editorFontClassName} ${markdownProseClassName}
              [& [data-suggestion-row-band]]:(
                absolute -z-10 bg-[color-mix(in srgb, var(--text) 4%, transparent)] md:bg-transparent
                md:bg-[linear-gradient(to right, transparent, color-mix(in srgb, var(--text) 4%, transparent) calc(var(--spacing) * 8), color-mix(in srgb, var(--text) 4%, transparent) calc(100% - var(--spacing) * 8), transparent)]
              )
              [& [data-suggestion-row-scroller]]:(
                pointer-events-auto absolute h-[44px] overflow-x-auto overflow-y-hidden [scrollbar-width:thin]
              )
              [& [data-suggestion-row-scroll-width]]:h-px
              [& [data-suggestion-row-old]]:(absolute select-text opacity-55)
              [& [data-suggestion-row-old] > :last-child]:mb-0
              [& [data-suggestion-row-head]]:(
                absolute flex h-[44px] items-center justify-between gap-2
                font-sans text-[0.72rem] leading-none
              )
              [& [data-suggestion-row-label]]:(font-semibold tracking-[0.06em] uppercase text-fg/55)
              [& [data-suggestion-row-action]]:(
                pointer-events-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-fg/muted
                border border-[color-mix(in srgb, var(--text) 10%, transparent)]
                transition hover:(bg-fg/6 text-text border-[color-mix(in srgb, var(--text) 18%, transparent)])
              )
              [& [data-suggestion-row-head][data-side=new] [data-suggestion-row-action]]:(text-accent hover:(bg-accent-soft text-accent))
              [& [data-suggestion-row-empty]]:(font-sans italic text-[0.85em] text-fg/50)
            `}
          />
          <MarkdownCommentMargin client={client} defaultAuthor={settings.get("userName")} layout={marginLayout.comments} />
          <div
            ref={customCaretRef}
            className="
              pointer-events-none absolute top-0 left-0 z-20 min-h-[1em] w-[2px] origin-center rounded-full
              bg-text [box-shadow: 0 0 0.35rem color-mix(in srgb, var(--shadow) 28%, transparent)]
              transform-[translate3d(0,0,0)] animate-blink
              data-[caret-kind=code]:bg-[color-mix(in srgb, var(--text) 56%, var(--bg) 44%)]
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

      <div ref={revisionHoverToolbarRef} className={workbenchRevisionHoverToolbarClassName} hidden>
        <button ref={revisionHoverAcceptButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Accept</button>
        <button ref={revisionHoverRejectButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Reject</button>
      </div>
    </div>
  );
}
