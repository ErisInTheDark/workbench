/*
 * Exports:
 * - default WorkbenchFilePanel: mount one editable file panel with panel-scoped editor client surfaces: a persistent
 *   markdown toolbar ending in the folder index, save (Save as with Shift, or for a new file, opening the path row
 *   above it) and hold-to-confirm reset, and the editor (or its markdown source)
 *   with its comment margin, suggestion originals and code block and table controls, followed by a row stepping between
 *   the folder's documents.
 */
"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import createFilePanelClient, { type WorkbenchFilePanelClient, type WorkbenchFilePanelSnapshot } from "../../../workbench/WorkbenchFilePanelClient";
import useFileDocument from "../../../workbench/file/use-file-document";
import { WORKBENCH_STICKY_CHROME_ATTRIBUTE, type WorkbenchEditorDomSurfaces } from "../../../workbench/workbench-dom";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, type WorkbenchEditorFontFamily } from "../../../workbench/state/workbench-settings";
import { MARK_TAG_SCOPE_ATTRIBUTE, markTagStyleSheet } from "../../../workbench/editor/mark-tag-styles";
import { useSettings } from "../use-settings";
import type MobileShellHeaderVisibilityController from "../MobileShellHeaderVisibilityController";
import IconButton from "../../ui/IconButton";
import Tooltip from "../../ui/Tooltip";
import { useWorkbenchSwapTab } from "../../../workbench/navigation/use-workbench-project-navigation";
import { withFileDestination, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import DocumentPager from "../markdown-editor/DocumentPager";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";
import DraftResetButton from "../markdown-editor/DraftResetButton";
import MarkdownCodeBlockChrome from "../markdown-editor/MarkdownCodeBlockChrome";
import MarkdownCommentMargin from "../markdown-editor/MarkdownCommentMargin";
import MarkdownTableChrome from "../markdown-editor/MarkdownTableChrome";
import MarkdownEditorToolbar from "../markdown-editor/MarkdownEditorToolbar";
import WorkbenchSaveAsRow from "../file-actions/WorkbenchSaveAsRow";
import WorkbenchSaveButton from "../file-actions/WorkbenchSaveButton";
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
import { BookBookmarkIcon } from "../workbench-icons";

const EDITOR_FONT_CLASS_NAMES: Record<WorkbenchEditorFontFamily, string> = {
  mono: "font-mono", sans: "font-sans", serif: "font-serif",
};

/** Typography of rendered markdown, shared by the editor and the suggestion originals shown beside it. */
const markdownProseClassName = `
  text-[1.08rem] text-fg/94 leading-[1.72] whitespace-normal [text-underline-offset:0.32em]
  [& :is(p, blockquote, ul, ol, pre, table)]:(m-0 mb-4 text-justify)
  [& :is(h1, h2, h3, h4, h5, h6)]:(mx-0 mt-[1.5em] mb-[0.5em] text-justify text-text-strong font-sans font-semibold leading-[1.15])
  [& :is(h1, h2, h3, h4, h5, h6) + :is(h1, h2, h3, h4, h5, h6)]:mt-[0.6em]
  [& > :first-child]:mt-0
  [& h1]:text-[2.05em] [& h2]:text-[1.55em] [& h3]:text-[1.25em]
  [& :is(ul, ol)]:(list-outside pl-[1.3rem])
  [& ul]:list-disc [& ul ul]:list-[circle] [& ul ul ul]:list-[square]
  [& ol]:list-decimal
  [& blockquote]:text-fg/muted
  [& hr]:(my-8 [margin-inline:10%] [border-color:color-mix(in srgb, var(--text), var(--app-bg-solid) 70%)])
  [& a]:(text-inherit decoration-accent decoration-[0.08em])
  [& code]:(font-mono text-[0.94em] bg-fg/7 rounded-[0.35rem] px-[0.34em] py-[0.08em])
  [& pre]:(
    relative max-w-full overflow-x-auto whitespace-pre rounded-[0.75rem] text-left leading-[1.55]
    px-[0.95rem] pb-[0.8rem] pt-[calc(var(--code-block-head)+0.8rem)]
    bg-[color-mix(in srgb, var(--text) 4%, transparent)]
    bg-[linear-gradient(to bottom, transparent calc(var(--code-block-head) - 1px), color-mix(in srgb, var(--text) 8%, transparent) calc(var(--code-block-head) - 1px), color-mix(in srgb, var(--text) 8%, transparent) var(--code-block-head), transparent var(--code-block-head))]
  )
  [& pre code]:(block w-max min-w-full bg-transparent rounded-none p-0 font-mono text-[0.94em])
  [&[data-code-wrap] pre]:(whitespace-pre-wrap wrap-anywhere)
  [&[data-code-wrap] pre code]:(w-full min-w-0)
  [& table]:(
    w-full border-separate border-spacing-0 overflow-hidden rounded-[0.75rem] text-left
    bg-[color-mix(in srgb, var(--text) 4%, transparent)] font-sans text-[0.92em] leading-[1.45]
  )
  [& thead tr]:bg-[color-mix(in srgb, var(--text) 5%, transparent)]
  [& :is(td, th)]:(min-w-[3rem] align-top text-left [overflow-wrap:anywhere])
  [& th]:(px-[0.65rem] py-[0.48rem] text-[0.82em] font-semibold border-b-2 border-[color-mix(in srgb, var(--text) 16%, transparent)])
  [& td]:(px-[0.85rem] py-[0.5rem] border-t border-[color-mix(in srgb, var(--text) 7%, transparent)])
  [& tbody tr:first-child td]:border-t-0
  [& :is(td, th)[data-align=center]]:text-center
  [& :is(td, th)[data-align=right]]:text-right
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
  fontSizePreview?: number | null;
  location: ProjectLocationReference | null;
  path: string;
  /** The file tab; the panel offers its folder index and steps between the folder's documents. */
  route: WorkbenchRoute;
  /** The main pane's shell header slides away on mobile scroll; the toolbar below it slides with it. */
  shellHeaderVisibility?: MobileShellHeaderVisibilityController;
  showManualFileActions?: boolean;
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
  location,
  path,
  route,
  shellHeaderVisibility,
  showManualFileActions = true,
}: WorkbenchFilePanelProps) {
  const shellHeaderVisible = useSyncExternalStore(
    shellHeaderVisibility?.subscribe ?? noSubscription,
    shellHeaderVisibility?.getVisible ?? alwaysVisible,
    alwaysVisible,
  );
  const settings = useSettings.forLocation(location);
  const editorFontClassName = EDITOR_FONT_CLASS_NAMES[settings.get("editorFontFamily")];
  const spellCheck = settings.get("editorSpellCheck");
  const fontSizeRem = Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE,
    Number((fontSizePreview ?? settings.get("editorFontSize")).toFixed(2))));
  const editorShellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const customCaretRef = useRef<HTMLDivElement>(null);
  const diffGutterRef = useRef<HTMLDivElement>(null);
  const reviewLayerRef = useRef<HTMLDivElement>(null);
  const filePathLabelRef = useRef<HTMLParagraphElement>(null);
  const statusLineRef = useRef<HTMLParagraphElement>(null);
  const saveConflictDialogRef = useRef<HTMLDivElement>(null);
  const saveConflictSummaryRef = useRef<HTMLParagraphElement>(null);
  const saveConflictExpectedRef = useRef<HTMLParagraphElement>(null);
  const saveConflictActualRef = useRef<HTMLParagraphElement>(null);
  const saveConflictKeepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictReloadButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictOverwriteButtonRef = useRef<HTMLButtonElement>(null);
  const revisionHoverToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const revisionHoverRejectButtonRef = useRef<HTMLButtonElement>(null);
  const [client, setClient] = useState<WorkbenchFilePanelClient | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchFilePanelSnapshot | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const file = useFileDocument(location, path);
  const isNewFile = snapshot?.isNewFile ?? false;
  const loading = !file.snapshot.data && !file.snapshot.failure && !isNewFile;
  const stickyToolbar = useStickyTopBelowChrome(!loading);

  const panelIdSuffix = useMemo(() => path.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "file", [path]);

  useEffect(() => {
    if (
      !file.document
      || !editorRef.current
      || !sourceRef.current
      || !customCaretRef.current
      || !diffGutterRef.current
      || !reviewLayerRef.current
      || !filePathLabelRef.current
      || !statusLineRef.current
      || !saveConflictDialogRef.current
      || !saveConflictSummaryRef.current
      || !saveConflictExpectedRef.current
      || !saveConflictActualRef.current
      || !saveConflictKeepEditingButtonRef.current
      || !saveConflictReloadButtonRef.current
      || !saveConflictOverwriteButtonRef.current
      || !revisionHoverToolbarRef.current
      || !revisionHoverAcceptButtonRef.current
      || !revisionHoverRejectButtonRef.current
    ) {
      return;
    }

    const surfaces: WorkbenchEditorDomSurfaces = {
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
      },
      editor: {
        customCaret: customCaretRef.current,
        diffGutter: diffGutterRef.current,
        editor: editorRef.current,
        reviewLayer: reviewLayerRef.current,
        source: sourceRef.current,
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

    const nextClient = createFilePanelClient({
      document: file.document,
      onSaveAsRequest: () => setSaveAsOpen(true),
      surfaces,
    });
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

  const userName = settings.get("userName");
  useEffect(() => {
    client?.setCommentAuthor(userName || null);
  }, [client, userName]);

  const markTags = settings.get("markTags");
  useEffect(() => {
    client?.setMarkTags(markTags);
  }, [client, markTags]);
  const markTagScope = useId();
  const markTagStyles = useMemo(() => markTagStyleSheet(markTagScope, markTags), [markTagScope, markTags]);

  const threadCount = useSyncExternalStore(
    client?.comments.subscribe ?? noSubscription,
    () => (client?.comments.getSnapshot().threads.length ?? 0) + (client?.comments.getSnapshot().draft ? 1 : 0),
    noThreads,
  );
  const marginLayout = useEditorMarginLayout(editorShellRef, editorRef, threadCount > 0);

  useEffect(() => {
    client?.setSuggestionLayout(marginLayout.suggestion);
  }, [client, marginLayout.suggestion]);

  const swapTab = useWorkbenchSwapTab();
  useEffect(() => { setSaveAsOpen(false); }, [path]);
  /** A discarded new file leaves its tab on the folder it was started in. */
  const discardNewFile = useCallback(async () => {
    if (!client) return;
    await client.discardNewFile();
    swapTab(withFileDestination(route, route.filePath, true));
  }, [client, route, swapTab]);
  const saveAsRow = saveAsOpen && client ? (
    <WorkbenchSaveAsRow
      initialPath={path}
      location={file.document?.location ?? location}
      onCancel={() => setSaveAsOpen(false)}
      onWritten={async (target) => {
        await client.handOffToCopy();
        setSaveAsOpen(false);
        swapTab(withFileDestination(route, target));
      }}
      readContent={client.readContent}
    />
  ) : null;
  /** The folder index, save and reset sit at the toolbar's end, beside undo and redo. */
  const fileActions = client && snapshot ? (
    <>
      <Tooltip placement="bottom" delayMs={350} content="Folder index">
        <IconButton
          type="button"
          title=""
          label="Folder index"
          size="small"
          display="hover-border"
          onClick={() => swapTab(withFileDestination(route, route.filePath, true))}
        >
          <BookBookmarkIcon size={16} />
        </IconButton>
      </Tooltip>
      <WorkbenchSaveButton
        invalid={snapshot.hasSaveIssue}
        onSave={() => { void client.save(); }}
        onSaveAs={() => setSaveAsOpen(true)}
        saveAsDisabled={!snapshot.currentPath}
        saveAsOnly={snapshot.isNewFile}
        saveDisabled={!snapshot.currentPath}
      />
      <DraftResetButton
        hasDraft={snapshot.dirty}
        isNewFile={snapshot.isNewFile}
        savedDiffersFromHead={snapshot.savedDiffersFromHead}
        onDeleteDraft={snapshot.isNewFile ? discardNewFile : client.deleteDraft}
        onRestoreFromGit={client.restoreFromGit}
      />
    </>
  ) : null;

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {file.snapshot.failure && !isNewFile ? <p role="alert">{file.snapshot.failure}</p> : null}
      {file.snapshot.data && file.snapshot.phase !== "current" && !file.snapshot.failure
        ? <p role="status">Waiting for current disk data...</p> : null}
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
          {saveAsRow ? <div className="px-5 md:pr-6 md:pl-[3.5rem]">{saveAsRow}</div> : null}
          <MarkdownEditorToolbar
            client={client}
            className="px-5 md:pr-6 md:pl-[3.5rem]"
            markTags={markTags}
            trailing={showManualFileActions ? fileActions : null}
          />
        </div>
      </div>}
      {/* The shell tab names the file and the toolbar holds save and reset; status is announced only. */}
      <p ref={filePathLabelRef} className="sr-only" />
      <p ref={statusLineRef} className="sr-only" aria-live="polite" />

      {loading ? <WorkbenchLoadingSpinner label="Loading file" /> : null}
      {/* The editor mounts while loading, hidden, so its client is ready the moment content arrives. */}
      <div className="relative min-h-0 flex-1 pt-3" hidden={loading}>
        {markTagStyles ? <style>{markTagStyles}</style> : null}
        <div
          ref={editorShellRef}
          {...{ [MARK_TAG_SCOPE_ATTRIBUTE]: markTagScope }}
          className="editor-shell relative mx-auto grid [--code-block-head:2.05rem] w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem minmax(0, 1fr)] gap-[0.53rem] md:max-w-[calc(var(--container-content)+2.5rem)] md:grid-cols-[1.25rem minmax(0, var(--container-content))] md:gap-3 -ml-5 md:ml-auto"
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
              editor-content col-start-2 row-start-1 min-h-[calc(100vh-6rem)]
              pb-16 ${editorFontClassName} ${markdownProseClassName} outline-none
              data-[custom-caret-visible=true]:caret-transparent
              empty:before:(text-fg/muted content-[attr(data-placeholder)])
              [& > p:only-child:has(> br:only-child)]:before:(absolute pointer-events-none text-fg/muted content-['Start_writing...'])
              [& [data-comment-thread]]:(select-none)
              [& [data-cell-selected]]:bg-[color-mix(in srgb, var(--accent) 16%, transparent)]
              [& table[data-cell-box]]:selection:bg-transparent
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
          {/* Source mode shows the file's markdown text here instead of the editor; the client switches which shows. */}
          <textarea
            ref={sourceRef}
            aria-label="Markdown source"
            className={`
              editor-source col-start-2 row-start-1 block w-full resize-none overflow-hidden bg-transparent p-0 pb-16
              min-h-[calc(100vh-6rem)] font-mono leading-[1.65] text-text whitespace-pre-wrap wrap-anywhere outline-none
            `}
            spellCheck={spellCheck}
          />
          <MarkdownCodeBlockChrome client={client} />
          <MarkdownTableChrome client={client} />
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
              [& [data-suggestion-row-old]]:(
                pointer-events-auto absolute cursor-text select-text opacity-55 outline-none transition-opacity
                hover:opacity-75 focus:opacity-90
              )
              [& [data-suggestion-row-old][data-suggestion-row-empty]]:before:(
                content-['Nothing_here_before'] absolute left-0 top-0 pointer-events-none font-sans italic text-[0.85em] text-fg/50
              )
              [& [data-suggestion-row-old] > :last-child]:mb-0
              [& pre]:before:(
                content-[attr(data-language)] absolute left-[0.95rem] top-0 flex h-(--code-block-head) items-center
                font-mono text-[0.72rem] leading-none text-fg/muted
              )
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
          <div className="col-start-2 pb-10"><DocumentPager location={location} route={route} /></div>
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

      <div ref={revisionHoverToolbarRef} className={workbenchRevisionHoverToolbarClassName} hidden>
        <button ref={revisionHoverAcceptButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Accept</button>
        <button ref={revisionHoverRejectButtonRef} type="button" className={workbenchRevisionActionButtonClassName}>Reject</button>
      </div>
    </div>
  );
}
