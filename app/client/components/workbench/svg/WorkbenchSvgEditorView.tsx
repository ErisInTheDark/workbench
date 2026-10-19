/*
 * Exports:
 * - default WorkbenchSvgEditorView: one SVG file as a live canvas beside its highlighted source, sharing selection, history, drafts,
 *   saves and Save as (always Save as for an unsaved new file). Mount with `key={path}` so selection and the last valid
 *   preview belong to one file.
 */
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";

import type { WorkbenchControls } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import TextFileDocumentController, {
  type TextFileDocumentPort,
  type TextFileDocumentState,
  type TextFileEditOptions,
} from "../../../workbench/file/TextFileDocumentController";
import {
  buildSvgHighlights, SVG_SEGMENT_PALETTE, SVG_SELECTED_EMPHASIS_CLASS, SVG_SELECTED_SOURCE_CLASS, SVG_SELECTED_TINT_CLASS,
  type SvgSourceEmphasis,
} from "../../../workbench/svg/svg-highlights";
import { buildSvgPreview, readSvgViewBox } from "../../../workbench/svg/svg-preview-dom";
import { getSvgSegments, groupSvgSelection, svgElementSelectionKeys, SVG_SEGMENT_TAGS } from "../../../workbench/svg/svg-segments";
import { formatSvgSource } from "../../../workbench/svg/svg-source-edits";
import { findSvgElementAt, getSvgAttribute, parseSvgSource, type SvgSourceElement } from "../../../workbench/svg/svg-source";
import type { WorkbenchMainPanelDragPayload } from "../../../workbench/layout/workbench-drag";
import IconButton from "../../ui/IconButton";
import { useWorkbenchDrag } from "../drag/workbench-drag-context";
import PlaintextEditable from "../thread-view/PlaintextEditable";
import WorkbenchSaveAsRow from "../file-actions/WorkbenchSaveAsRow";
import WorkbenchSaveButton from "../file-actions/WorkbenchSaveButton";
import DraftResetButton from "../markdown-editor/DraftResetButton";
import { PanelCloseIcon, Redo2Icon, ResetIcon, Undo2Icon, WandSparklesIcon } from "../workbench-icons";
import WorkbenchSvgCanvas, { type SvgCanvasAction, type SvgCanvasTool } from "./WorkbenchSvgCanvas";
import WorkbenchSvgToolbar, { type SvgViewOptions } from "./WorkbenchSvgToolbar";

type TextFileDocumentControls = WorkbenchControls & {
  createTextFileDocumentPort(path: string, location?: ProjectLocationReference | null): TextFileDocumentPort;
};

const TYPING_COALESCE = { key: "typing", windowMs: 1000 };
const REAL_SIZES = [16, 24, 32, 48];
const LOADING_STATE: TextFileDocumentState = {
  status: "loading", content: "", baseline: "", dirty: false, saving: false, conflict: null, error: "", canUndo: false,
  canRedo: false, isNew: false,
};
const DEFAULT_VIEW: SvgViewOptions = { colors: true, grid: true, guides: true, snap: "0.5" };
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
const noSubscription = () => () => undefined;
const loadingSnapshot = () => LOADING_STATE;

const sourceEditorClassName = `
  block min-h-full whitespace-pre-wrap wrap-anywhere px-4 py-3 font-mono text-[0.82rem] leading-5 outline-none
  data-[empty=true]:before:(content-[attr(data-placeholder)] pointer-events-none text-fg/muted)
`;

function hasTextFileDocumentPort(controls: WorkbenchControls): controls is TextFileDocumentControls {
  return "createTextFileDocumentPort" in controls;
}

function describeSelection(elements: readonly SvgSourceElement[], selection: ReadonlySet<string>) {
  const grouped = groupSvgSelection(selection);
  if (!grouped.size) return null;
  if (grouped.size > 1) return `${grouped.size} shapes`;
  const [[index, segments]] = [...grouped];
  const element = elements[index];
  if (!element) return null;
  const id = getSvgAttribute(element, "id");
  const name = id ? `<${element.name}#${id}>` : `<${element.name}>`;
  const total = getSvgSegments(element).length;
  return segments && total > 1 && segments.size < total ? `${segments.size} of ${total} segments of ${name}` : name;
}

function useTextFileDocument(port: TextFileDocumentPort | null) {
  const [controller, setController] = useState<TextFileDocumentController | null>(null);
  useEffect(() => {
    if (!port) return;
    const next = new TextFileDocumentController(port);
    setController(next);
    void next.load();
    const refresh = () => { if (window.document.visibilityState === "visible") void next.refreshIfClean(); };
    window.addEventListener("focus", refresh);
    window.document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.document.removeEventListener("visibilitychange", refresh);
      next.dispose();
      setController(current => current === next ? null : current);
    };
  }, [port]);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? loadingSnapshot,
    controller?.getSnapshot ?? loadingSnapshot);
  return { controller, state };
}

/** One isolated copy per size so ids and styles cannot collide; it inherits the app text colour as currentColor. */
function RealSizePreview({ root, size }: { root: SvgSourceElement; size: number }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const preview = buildSvgPreview(window.document, root);
    preview.setAttribute("width", String(size));
    preview.setAttribute("height", String(size));
    preview.style.display = "block";
    shadow.replaceChildren(preview);
  }, [root, size]);
  return <span ref={hostRef} role="img" aria-label={`${size}px`} title={`${size}px`} className="block text-text" style={{ width: size, height: size }} />;
}

function RealSizePreviews({ root }: { root: SvgSourceElement }) {
  return (
    <div aria-label="Real-size previews" className="flex items-end justify-center gap-5 py-1" role="group">
      {REAL_SIZES.map(size => <RealSizePreview key={size} root={root} size={size} />)}
    </div>
  );
}

export default function WorkbenchSvgEditorView({
  contained = false,
  controls,
  location = null,
  onClose,
  headerDrag,
  onDiscarded,
  onOpenCopy,
  path,
  sidebarToggleInset,
}: {
  contained?: boolean;
  controls: WorkbenchControls | null;
  location?: ProjectLocationReference | null;
  onClose?: () => void;
  headerDrag?: WorkbenchMainPanelDragPayload;
  /** An unsaved new file was discarded; leave this view. Without it, new files cannot be discarded here. */
  onDiscarded?: () => void;
  /** Show the copy Save as wrote in place of this file. Without it, Save as is not offered. */
  onOpenCopy?: (path: string) => void;
  path: string;
  sidebarToggleInset?: "collapsed" | "expanded";
}) {
  const daemonId = location?.daemonId ?? null;
  const projectId = location?.projectId ?? null;
  const stableLocation = useMemo(() => location, [daemonId, projectId]);
  const opened = useMemo((): { port: TextFileDocumentPort | null; error: string } => {
    if (!controls || !hasTextFileDocumentPort(controls)) return { port: null, error: "" };
    try {
      return { port: controls.createTextFileDocumentPort(path, stableLocation), error: "" };
    } catch (error) {
      return { port: null, error: error instanceof Error ? error.message : "This file cannot be opened." };
    }
  }, [controls, path, stableLocation]);
  const portError = opened.error;
  const { controller, state } = useTextFileDocument(opened.port);
  const parsed = useMemo(() => parseSvgSource(state.content), [state.content]);
  const lastValid = useRef<Extract<typeof parsed, { ok: true }> | null>(null);
  if (parsed.ok) lastValid.current = parsed;
  const shown = parsed.ok ? parsed : lastValid.current;
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const selectionOrigin = useRef<"canvas" | "source">("canvas");
  const [tool, setTool] = useState<SvgCanvasTool>("select");
  const [view, setView] = useState<SvgViewOptions>(DEFAULT_VIEW);
  const [action, setAction] = useState<SvgCanvasAction | null>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const beginDrag = useWorkbenchDrag.mainPanel();
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const openSaveAs = onOpenCopy && state.status === "ready" ? () => setSaveAsOpen(true) : undefined;

  const segmentRanges = useMemo(() => {
    if (!parsed.ok) return [];
    let colorIndex = 0;
    return parsed.elements.flatMap(element => SVG_SEGMENT_TAGS.has(element.name) ? getSvgSegments(element).map(segment => ({
      segment, color: SVG_SEGMENT_PALETTE[colorIndex++ % SVG_SEGMENT_PALETTE.length]!.sourceClass,
    })) : []);
  }, [parsed]);

  const highlights = useMemo(() => {
    const emphases: SvgSourceEmphasis[] = [];
    if (view.colors) {
      for (const { segment, color } of segmentRanges) if (segment.range) emphases.push({ ...segment.range, className: color });
    }
    const selectedClass = view.colors ? SVG_SELECTED_EMPHASIS_CLASS : `${SVG_SELECTED_EMPHASIS_CLASS} ${SVG_SELECTED_TINT_CLASS}`;
    if (parsed.ok) {
      for (const [index, segments] of groupSvgSelection(selection)) {
        const element = parsed.elements[index];
        if (!element) continue;
        const all = getSvgSegments(element);
        const partial = segments && all.length > 1 && segments.size < all.length;
        if (!partial) emphases.push({ start: element.start, end: element.end, className: selectedClass });
        else for (const segment of all) if (segments.has(segment.index) && segment.range) {
          emphases.push({ ...segment.range, className: selectedClass });
        }
      }
    }
    return buildSvgHighlights(state.content, parsed.tokens, emphases);
  }, [parsed, segmentRanges, selection, state.content, view.colors]);

  useEffect(() => {
    if (selectionOrigin.current !== "canvas" || !selection.size) return;
    sourceRef.current?.querySelector(`.${SVG_SELECTED_SOURCE_CLASS}`)?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const selectFromCanvas = (keys: ReadonlySet<string>) => {
    selectionOrigin.current = "canvas";
    setSelection(keys);
  };

  function selectFromSource(range: { start: number; end: number } | null) {
    if (!range || !parsed.ok) return;
    selectionOrigin.current = "source";
    if (range.end > range.start) {
      const keys = segmentRanges.filter(({ segment }) => segment.range && segment.range.start < range.end && range.start < segment.range.end)
        .map(({ segment }) => segment.key);
      if (keys.length) { setSelection(new Set(keys)); return; }
    }
    const inSegment = segmentRanges.find(({ segment }) => segment.kind !== "shape" && segment.range
      && segment.range.start <= range.start && range.start < segment.range.end);
    if (inSegment) { setSelection(new Set([inSegment.segment.key])); return; }
    const element = findSvgElementAt(parsed.elements, range.start);
    setSelection(element && element.index > 0 ? new Set(svgElementSelectionKeys(element)) : new Set());
  }

  const edit = (next: string, options?: TextFileEditOptions) => controller?.edit(next, options);
  const format = () => {
    const formatted = formatSvgSource(state.content);
    if (formatted !== null) controller?.edit(formatted);
  };
  const runAction = (command: SvgCanvasAction["kind"] | DistributiveOmit<SvgCanvasAction, "id">) =>
    setAction(current => ({ id: (current?.id ?? 0) + 1, ...(typeof command === "string" ? { kind: command } : command) } as SvgCanvasAction));

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      if (event.shiftKey || state.isNew) openSaveAs?.();
      else void controller?.save();
    } else if (key === "z" || key === "y") {
      event.preventDefault();
      if (key === "y" || event.shiftKey) controller?.redo();
      else controller?.undo();
    }
  }

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (!headerDrag || (event.target instanceof HTMLElement && event.target.closest("button,a,input,[contenteditable]"))) return;
    event.preventDefault();
    beginDrag(event, headerDrag);
  }

  const status = portError || state.error
    || (state.saving ? "Saving..." : state.isNew ? "Not saved yet. Name it with Save as."
      : state.dirty ? "Unsaved changes. Save with Ctrl/Cmd+S." : state.status === "ready" ? "Saved" : "");
  const parseMessage = parsed.ok ? null : `Line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}`;
  const selectionLabel = shown ? describeSelection(shown.elements, selection) : null;
  const canCirclify = parsed.ok && [...groupSvgSelection(selection)].some(([index, segments]) =>
    segments && parsed.elements[index] && getSvgSegments(parsed.elements[index]!).some(segment =>
      segments.has(segment.index) && segment.kind === "arc" && segment.circle));

  return (
    <div
      className={`
        flex min-w-0 flex-col
        ${contained ? "h-full min-h-[24rem]" : "min-h-0 flex-1"}
      `}
      data-svg-editor-path={path}
      onKeyDown={handleKeyDown}
    >
      {/* In the main pane the shell tab names the file; mosaic panels carry their own draggable title. */}
      {!contained ? null : (
        <header
          className={`
            flex items-center gap-2 pt-3
            ${sidebarToggleInset === "collapsed" ? "md:pl-28" : sidebarToggleInset === "expanded" ? "md:pl-14" : ""}
            ${headerDrag ? "cursor-grab active:cursor-grabbing" : ""}
          `}
          onPointerDown={handleHeaderPointerDown}
        >
          <p className="m-0 min-w-0 flex-1 truncate text-base font-semibold leading-tight">{path}</p>
          {onClose ? <IconButton label="Close panel" display="hover-border" onClick={onClose}><PanelCloseIcon size={16} /></IconButton> : null}
        </header>
      )}
      {saveAsOpen && controller && onOpenCopy ? (
        <WorkbenchSaveAsRow
          initialPath={path}
          location={location}
          onCancel={() => setSaveAsOpen(false)}
          onWritten={async (target) => {
            await controller.handOffToCopy({ samePath: target === path });
            setSaveAsOpen(false);
            if (target !== path) onOpenCopy(target);
          }}
          readContent={() => controller.getSnapshot().content}
        />
      ) : null}
      <WorkbenchSvgToolbar
        canCirclify={canCirclify}
        canvasSize={shown ? readSvgViewBox(shown.root) : null}
        fileActions={<>
          <IconButton label="Undo" title="Undo (Ctrl/Cmd+Z)" size="small" display="hover-border" disabled={!state.canUndo}
            onClick={() => controller?.undo()}><Undo2Icon size={16} /></IconButton>
          <IconButton label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)" size="small" display="hover-border" disabled={!state.canRedo}
            onClick={() => controller?.redo()}><Redo2Icon size={16} /></IconButton>
          <IconButton label="Format source" size="small" display="hover-border" disabled={!parsed.ok || state.status !== "ready"}
            onClick={format}><WandSparklesIcon size={16} /></IconButton>
          <WorkbenchSaveButton
            onSave={() => { void controller?.save(); }}
            onSaveAs={openSaveAs}
            saveAsDisabled={state.status !== "ready"}
            saveAsOnly={state.isNew}
            saveDisabled={!state.dirty || state.saving}
            saving={state.saving}
          />
          {state.isNew ? (onDiscarded ? (
            <DraftResetButton
              hasDraft
              isNewFile
              onDeleteDraft={async () => {
                await controller?.discard();
                onDiscarded();
              }}
              savedDiffersFromHead={false}
            />
          ) : null) : (
            <IconButton label="Revert to saved" title="Revert to saved (undoable)" size="small" display="hover-border" tone="danger"
              disabled={!state.dirty} onClick={() => controller?.revert()}><ResetIcon size={16} /></IconButton>
          )}
        </>}
        onCirclify={() => runAction("circlify")}
        onFlip={axis => runAction(axis === "horizontal" ? "flip-horizontal" : "flip-vertical")}
        onOptionsChange={setView}
        onResize={(width, height, scaleContent) => runAction({ kind: "resize-canvas", width, height, scaleContent })}
        onToolChange={setTool}
        options={view}
        tool={tool}
      />

      {state.conflict ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-[0.9rem] bg-danger/10 px-3 py-2 text-[0.84rem] text-danger">
          <span className="mr-auto">{state.conflict}</span>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-danger/10" onClick={() => { void controller?.reloadFromDisk(); }}>Reload from disk</button>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-danger/10" onClick={() => { void controller?.save({ force: true }); }}>Overwrite anyway</button>
          <button type="button" className="rounded-lg px-2 py-1 text-fg/muted hover:bg-fg/5" onClick={() => controller?.dismissConflict()}>Keep editing</button>
        </div>
      ) : null}

      {state.status === "failed" || portError ? (
        <p role="alert" className="py-8 text-danger">{portError || state.error}</p>
      ) : state.status === "loading" ? (
        <p role="status" className="py-8 text-fg/muted">Loading {path}...</p>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 pb-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section aria-label="Canvas" className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="relative aspect-square min-h-0 w-full md:aspect-auto md:flex-1">
              {shown ? (
                <WorkbenchSvgCanvas
                  action={action}
                  colors={view.colors}
                  document={shown}
                  grid={view.grid}
                  guides={view.guides}
                  onEdit={parsed.ok ? edit : () => undefined}
                  onEditSettled={() => controller?.persistDraft()}
                  onSelectionChange={selectFromCanvas}
                  onToolChange={setTool}
                  selection={selection}
                  snap={view.snap === "off" ? null : Number(view.snap)}
                  text={state.content}
                  tool={tool}
                />
              ) : (
                <div className="flex size-full items-center justify-center rounded-[1rem] bg-fg/5 p-6 text-center text-[0.84rem] text-fg/muted">
                  Fix the source to see a preview.
                </div>
              )}
            </div>
            <p className="m-0 min-h-[2lh] text-[0.78rem] text-fg/muted">
              {!parsed.ok && shown ? "Showing the last valid preview; editing on the canvas resumes once the source parses. "
                : selectionLabel ? `${selectionLabel} selected. Drag to move (Alt: free), arrows nudge, Del removes, Ctrl/Cmd+D duplicates, Ctrl/Cmd+C/V copies between tabs.`
                : "Click a segment; Shift-click selects the full element (then adds segments); double-click for the whole shape; drag empty space to box-select."}
            </p>
            {shown ? <RealSizePreviews root={shown.root} /> : null}
          </section>

          <section aria-label="Source" className="flex min-h-0 min-w-0 flex-col gap-2">
            <div ref={sourceRef} className="scrollbar-hover-reveal min-h-[16rem] flex-1 overflow-auto rounded-[1rem] bg-text/[0.03] focus-within:bg-text/[0.05]">
              <PlaintextEditable
                ariaLabel={`${path} source`}
                className={sourceEditorClassName}
                highlightText
                highlights={highlights}
                onSelectionChange={selectFromSource}
                onChange={value => edit(value, { coalesce: TYPING_COALESCE })}
                onKeyDown={event => {
                  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                    event.preventDefault();
                    window.document.execCommand("insertText", false, "  ");
                  }
                }}
                placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>'}
                value={state.content}
              />
            </div>
            <div className="flex min-h-[2lh] items-start text-[0.78rem]">
              {parseMessage
                ? <p role="alert" className="m-0 min-w-0 text-danger">{parseMessage}</p>
                : <p role="status" className={`m-0 min-w-0 ${portError || state.error ? "text-danger" : "text-fg/muted"}`}>{status || "Loading..."}</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
