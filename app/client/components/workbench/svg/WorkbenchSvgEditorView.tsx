/*
 * Exports:
 * - default WorkbenchSvgEditorView: one SVG file as a live preview/editor beside its highlighted source, sharing history, drafts and saves.
 *   Mount with `key={path}` so selection and the last valid preview belong to one file.
 */
"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";

import type { WorkbenchControls } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import TextFileDocumentController, {
  type TextFileDocumentPort,
  type TextFileDocumentState,
  type TextFileEditOptions,
} from "../../../workbench/file/TextFileDocumentController";
import { buildSvgHighlights, SVG_SELECTED_SOURCE_CLASS } from "../../../workbench/svg/svg-highlights";
import { buildSvgPreview, svgPreviewDataUrl } from "../../../workbench/svg/svg-preview-dom";
import { formatSvgSource } from "../../../workbench/svg/svg-source-edits";
import { findSvgElementAt, getSvgAttribute, parseSvgSource, type SvgSourceElement } from "../../../workbench/svg/svg-source";
import IconButton from "../../ui/IconButton";
import RadioRow from "../../ui/RadioRow";
import PlaintextEditable from "../thread-view/PlaintextEditable";
import {
  Grid3x3Icon,
  PanelCloseIcon,
  Redo2Icon,
  ResetIcon,
  SaveIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "../workbench-icons";
import WorkbenchSvgCanvas, { type SvgCanvasBackground } from "./WorkbenchSvgCanvas";

type TextFileDocumentControls = WorkbenchControls & {
  createTextFileDocumentPort(path: string, location?: ProjectLocationReference | null): TextFileDocumentPort;
};

type SnapChoice = "off" | "1" | "0.5" | "0.25";

const TYPING_COALESCE = { key: "typing", windowMs: 1000 };
const REAL_SIZES = [16, 24, 32, 48];
const PREVIEW_COLORS = { light: "#17161b", dark: "#f4f1ea" };
const LOADING_STATE: TextFileDocumentState = {
  status: "loading", content: "", baseline: "", dirty: false, saving: false, conflict: null, error: "", canUndo: false, canRedo: false,
};
const noSubscription = () => () => undefined;
const loadingSnapshot = () => LOADING_STATE;

const sourceEditorClassName = `
  block min-h-full whitespace-pre-wrap wrap-anywhere px-4 py-3 font-mono text-[0.82rem] leading-5 outline-none
  data-[empty=true]:before:(content-[attr(data-placeholder)] pointer-events-none text-fg/muted)
`;

function hasTextFileDocumentPort(controls: WorkbenchControls): controls is TextFileDocumentControls {
  return "createTextFileDocumentPort" in controls;
}

function describeElement(element: SvgSourceElement) {
  const id = getSvgAttribute(element, "id");
  return id ? `<${element.name}#${id}>` : `<${element.name}>`;
}

function useTextFileDocument(port: TextFileDocumentPort | null) {
  const [controller, setController] = useState<TextFileDocumentController | null>(null);
  useEffect(() => {
    if (!port) return;
    const next = new TextFileDocumentController(port);
    setController(next);
    void next.load();
    const refresh = () => { if (document.visibilityState === "visible") void next.refreshIfClean(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      next.dispose();
      setController(current => current === next ? null : current);
    };
  }, [port]);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? loadingSnapshot,
    controller?.getSnapshot ?? loadingSnapshot);
  return { controller, state };
}

function RealSizePreviews({ root }: { root: SvgSourceElement }) {
  const urls = useMemo(() => {
    if (typeof document === "undefined") return null;
    const preview = buildSvgPreview(document, root);
    return {
      light: REAL_SIZES.map(size => svgPreviewDataUrl(preview, size, PREVIEW_COLORS.light)),
      dark: REAL_SIZES.map(size => svgPreviewDataUrl(preview, size, PREVIEW_COLORS.dark)),
    };
  }, [root]);
  if (!urls) return null;
  return (
    <div aria-label="Real-size previews" className="flex flex-wrap items-end gap-2" role="group">
      {(["light", "dark"] as const).map(tone => (
        <div key={tone} className={`flex items-end gap-3 rounded-[0.8rem] px-3 py-2 ${tone === "light" ? "bg-white" : "bg-[#17161b]"}`}>
          {REAL_SIZES.map((size, index) => (
            <img key={size} alt={`${size}px on ${tone}`} title={`${size}px`} src={urls[tone][index]}
              width={size} height={size} draggable={false} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function WorkbenchSvgEditorView({
  contained = false,
  controls,
  location = null,
  onClose,
  onHeaderPointerDragStart,
  path,
  sidebarToggleInset,
}: {
  contained?: boolean;
  controls: WorkbenchControls | null;
  location?: ProjectLocationReference | null;
  onClose?: () => void;
  onHeaderPointerDragStart?: (event: PointerEvent<HTMLElement>) => void;
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
  const [selection, setSelection] = useState<{ index: number; origin: "canvas" | "source" } | null>(null);
  const [background, setBackground] = useState<SvgCanvasBackground>("checker");
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState<SnapChoice>("0.5");
  const sourceRef = useRef<HTMLDivElement>(null);
  const selectedElement = selection && shown ? shown.elements[selection.index] ?? null : null;
  const selectedIndex = selectedElement ? selectedElement.index : null;
  const highlights = useMemo(() => buildSvgHighlights(state.content, parsed.tokens,
    parsed.ok && selectedElement ? { start: selectedElement.start, end: selectedElement.end } : null),
  [parsed, selectedElement, state.content]);

  useEffect(() => {
    if (selection?.origin !== "canvas") return;
    sourceRef.current?.querySelector(`.${SVG_SELECTED_SOURCE_CLASS}`)?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const edit = (next: string, options?: TextFileEditOptions) => controller?.edit(next, options);
  const format = () => {
    const formatted = formatSvgSource(state.content);
    if (formatted !== null) controller?.edit(formatted);
  };

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void controller?.save();
    } else if (key === "z" || key === "y") {
      event.preventDefault();
      if (key === "y" || event.shiftKey) controller?.redo();
      else controller?.undo();
    }
  }

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (!onHeaderPointerDragStart || (event.target instanceof HTMLElement && event.target.closest("button,a,input,[contenteditable]"))) return;
    event.preventDefault();
    onHeaderPointerDragStart(event);
  }

  const status = portError || state.error
    || (state.saving ? "Saving..." : state.dirty ? "Unsaved changes. Save with Ctrl/Cmd+S." : state.status === "ready" ? "Saved" : "");
  const parseMessage = parsed.ok ? null : `Line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}`;

  return (
    <div
      className={`flex min-w-0 flex-col ${contained ? "h-full min-h-[24rem]" : "min-h-[calc(100dvh-1rem)] md:h-dvh"}`}
      data-svg-editor-path={path}
      onKeyDown={handleKeyDown}
    >
      <header
        className={`
          flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between
          ${sidebarToggleInset === "collapsed" ? "md:pl-28" : sidebarToggleInset === "expanded" ? "md:pl-14" : ""}
          ${onHeaderPointerDragStart ? "cursor-grab active:cursor-grabbing" : ""}
        `}
        onPointerDown={handleHeaderPointerDown}
      >
        <div className="order-2 min-w-0 md:order-1">
          <p className="truncate text-base font-semibold leading-tight">{path}</p>
          <p role="status" className={`mt-1 text-[0.84rem] tracking-[0.02em] ${portError || state.error ? "text-danger" : "text-fg/muted"}`}>
            {status || "Loading..."}
          </p>
        </div>
        <div className="order-1 flex items-center gap-1.5 md:order-2 md:ml-auto">
          <IconButton label="Undo" title="Undo (Ctrl/Cmd+Z)" display="hover-border" disabled={!state.canUndo}
            onClick={() => controller?.undo()}><Undo2Icon size={18} /></IconButton>
          <IconButton label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)" display="hover-border" disabled={!state.canRedo}
            onClick={() => controller?.redo()}><Redo2Icon size={18} /></IconButton>
          <IconButton label="Format source" display="hover-border" disabled={!parsed.ok || state.status !== "ready"}
            onClick={format}><WandSparklesIcon size={18} /></IconButton>
          <IconButton label="Save current file" title="Save (Ctrl/Cmd+S)" display="hover-border"
            disabled={!state.dirty || state.saving} pendingHalo={state.saving} onClick={() => { void controller?.save(); }}>
            <SaveIcon size={20} />
          </IconButton>
          <IconButton label="Revert to saved" title="Revert to saved (undoable)" display="hover-border" tone="danger"
            disabled={!state.dirty} onClick={() => controller?.revert()}><ResetIcon size={18} /></IconButton>
          {onClose ? <IconButton label="Close panel" display="hover-border" onClick={onClose}><PanelCloseIcon size={16} /></IconButton> : null}
        </div>
      </header>

      {state.conflict ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-[0.9rem] bg-danger/10 px-3 py-2 text-[0.84rem] text-danger">
          <span className="mr-auto">{state.conflict}</span>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-danger/10" onClick={() => { void controller?.reloadFromDisk(); }}>
            Reload from disk
          </button>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-danger/10" onClick={() => { void controller?.save({ force: true }); }}>
            Overwrite anyway
          </button>
          <button type="button" className="rounded-lg px-2 py-1 text-fg/muted hover:bg-fg/5" onClick={() => controller?.dismissConflict()}>
            Keep editing
          </button>
        </div>
      ) : null}

      {state.status === "failed" || portError ? (
        <p role="alert" className="py-8 text-danger">{portError || state.error}</p>
      ) : state.status === "loading" ? (
        <p role="status" className="py-8 text-fg/muted">Loading {path}...</p>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 pb-5 md:grid-cols-2">
          <section aria-label="Preview" className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <RadioRow<SvgCanvasBackground> ariaLabel="Preview background" value={background} onChange={setBackground} options={[
                { label: "Checker", value: "checker" }, { label: "Light", value: "light" }, { label: "Dark", value: "dark" },
              ]} />
              <IconButton label={grid ? "Hide grid" : "Show grid"} size="small" display="hover-border" aria-pressed={grid}
                onClick={() => setGrid(current => !current)}><Grid3x3Icon size={16} /></IconButton>
              <RadioRow<SnapChoice> ariaLabel="Snap points to" value={snap} onChange={setSnap} options={[
                { label: "Free", value: "off", title: "Drag without snapping" },
                { label: "1", value: "1", title: "Snap to whole units" },
                { label: "1/2", value: "0.5", ariaLabel: "Half units", title: "Snap to half units" },
                { label: "1/4", value: "0.25", ariaLabel: "Quarter units", title: "Snap to quarter units" },
              ]} />
            </div>
            <div className="relative aspect-square min-h-0 w-full md:aspect-auto md:flex-1">
              {shown ? (
                <WorkbenchSvgCanvas
                  background={background}
                  elements={shown.elements}
                  grid={grid}
                  onEdit={edit}
                  onEditSettled={() => controller?.persistDraft()}
                  onSelect={index => setSelection(index === null ? null : { index, origin: "canvas" })}
                  root={shown.root}
                  selectedIndex={selectedIndex}
                  snap={snap === "off" ? null : Number(snap)}
                  text={state.content}
                />
              ) : (
                <div className="flex size-full items-center justify-center rounded-[1rem] bg-fg/5 p-6 text-center text-[0.84rem] text-fg/muted">
                  Fix the source to see a preview.
                </div>
              )}
            </div>
            <p className="m-0 min-h-[2lh] text-[0.78rem] text-fg/muted">
              {!parsed.ok && shown ? "Showing the last valid preview. "
                : selectedElement ? `${describeElement(selectedElement)} selected. Drag points or the shape; Alt drags freely, arrows nudge, Delete removes, Ctrl/Cmd+D duplicates.`
                : "Click a shape to select it, or place the caret inside its source."}
            </p>
            {shown ? <RealSizePreviews root={shown.root} /> : null}
          </section>

          <section aria-label="Source" className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="flex min-h-8 items-center gap-2">
              <h3 className="m-0 text-sm font-semibold text-text">Source</h3>
              {parseMessage ? <p role="alert" className="m-0 min-w-0 truncate text-[0.78rem] text-danger" title={parseMessage}>{parseMessage}</p> : null}
            </div>
            <div ref={sourceRef} className="scrollbar-hover-reveal min-h-[16rem] flex-1 overflow-auto rounded-[1rem] bg-text/[0.03] focus-within:bg-text/[0.05]">
              <PlaintextEditable
                ariaLabel={`${path} source`}
                className={sourceEditorClassName}
                highlightText
                highlights={highlights}
                onCaretChange={offset => {
                  if (offset === null || !parsed.ok) return;
                  const element = findSvgElementAt(parsed.elements, offset);
                  setSelection(element && element.index > 0 ? { index: element.index, origin: "source" } : null);
                }}
                onChange={value => edit(value, { coalesce: TYPING_COALESCE })}
                onKeyDown={event => {
                  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                    event.preventDefault();
                    document.execCommand("insertText", false, "  ");
                  }
                }}
                placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>'}
                value={state.content}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
