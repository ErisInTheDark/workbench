/*
 * Exports:
 * - SvgCanvasTool: canvas pointer tools.
 * - SvgCanvasAction: one-shot commands the editor sends to the canvas.
 * - default WorkbenchSvgCanvas: isolated live preview with coloured segments, guides, segment and box selection, point and selection
 *   dragging, drawing tools, keyboard edits and clipboard exchange with other canvases.
 */
"use client";

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode,
} from "react";

import type { TextFileEditOptions } from "../../../workbench/file/TextFileDocumentController";
import { analyzeSvgSegments, type SvgRootSegment } from "../../../workbench/svg/svg-analysis";
import { insertSvgMarkup, svgSelectionMarkup } from "../../../workbench/svg/svg-clipboard";
import { getSvgShape } from "../../../workbench/svg/svg-geometry";
import { formatSvgNumber, type SvgPoint } from "../../../workbench/svg/svg-path-data";
import { buildSvgPreview, readSvgViewBox, SVG_SOURCE_INDEX_ATTRIBUTE } from "../../../workbench/svg/svg-preview-dom";
import {
  getSvgSegments, groupSvgSelection, svgElementKey, svgElementSelectionKeys, SVG_SEGMENT_TAGS, type SvgSegment,
} from "../../../workbench/svg/svg-segments";
import {
  deleteSvgSelection, duplicateSvgSelection, moveSvgSelection, transformSvgSelection, type SvgParsedDocument,
} from "../../../workbench/svg/svg-selection-edits";
import { applySvgAttributeEdits } from "../../../workbench/svg/svg-source-edits";
import { circlifySvgSegments } from "../../../workbench/svg/svg-segments";
import { parseSvgSource, type SvgSourceElement } from "../../../workbench/svg/svg-source";
import WorkbenchSvgCanvasOverlay, { type SvgElementLayer, type SvgOverlayHandle } from "./WorkbenchSvgCanvasOverlay";

export type SvgCanvasTool = "select" | "pen" | "line" | "rect" | "circle";
export type SvgCanvasAction =
  | { id: number; kind: "flip-horizontal" | "flip-vertical" | "circlify" | "delete" | "duplicate" }
  | { id: number; kind: "resize-canvas"; width: number; height: number; scaleContent: boolean };

const PREVIEW_STYLE = `
  :host { display: block; }
  svg[${SVG_SOURCE_INDEX_ATTRIBUTE}="0"] { display: block; width: 100%; height: 100%; }
  :is(path, line, polyline, polygon, circle, rect, ellipse, text, use, image)[${SVG_SOURCE_INDEX_ATTRIBUTE}] { pointer-events: all; }
`;
/** Grid lines are whole svg units; only canvases too large to show unit lines fall back to coarser steps. */
const GRID_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const MIN_GRID_PIXELS = 4;
const DRAG_THRESHOLD_PIXELS = 3;
const CLOSE_PATH_PIXELS = 8;
const POINT_SNAP_UNITS = 0.75;
const NUDGE_COALESCE_MS = 800;
const SAMPLE_SPACING_UNITS = 0.25;
const MAX_SAMPLES_PER_SEGMENT = 400;
const NON_RENDERED = new Set(["defs", "clipPath", "mask", "symbol", "pattern", "marker", "linearGradient", "radialGradient"]);
const TOOL_KEYS: Record<string, SvgCanvasTool> = { v: "select", p: "pen", l: "line", r: "rect", c: "circle" };


/** `handle` is the outgoing tangent of the last anchor; `pendingHandle` is the one being dragged out of the newest anchor. */
type PenDraft = {
  elementIndex: number; parts: string[]; start: SvgPoint; last: SvgPoint; handle: SvgPoint | null; pendingHandle: SvgPoint | null; key: string;
};

type Drag =
  | { kind: "handle"; pointerId: number; key: string; text: string; element: SvgSourceElement; handleId: string; inverse: DOMMatrix }
  | { kind: "move"; pointerId: number; key: string; text: string; document: SvgParsedDocument; selection: ReadonlySet<string>;
    startClient: SvgPoint; startRoot: SvgPoint; anchorRoot: SvgPoint; moved: boolean; collapseTo: string | null }
  | { kind: "marquee"; pointerId: number; from: SvgPoint; to: SvgPoint; additive: boolean; startClient: SvgPoint; moved: boolean }
  | { kind: "shape"; pointerId: number; key: string; text: string; document: SvgParsedDocument; tool: "line" | "rect" | "circle";
    from: SvgPoint; elementIndex: number | null }
  | { kind: "pen"; pointerId: number; at: SvgPoint; startClient: SvgPoint };

interface Measured {
  scale: number;
  matrices: Map<number, DOMMatrix>;
  strokeWidths: Map<number, number>;
  rootSegments: SvgRootSegment[];
}

let dragSequence = 0;

const transform = (point: SvgPoint, matrix: DOMMatrix) => {
  const next = new DOMPoint(point.x, point.y).matrixTransform(matrix);
  return { x: next.x, y: next.y };
};
const matrixAttribute = (matrix: DOMMatrix) => `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
const n = formatSvgNumber;

function keysForInserted(text: string, indices: readonly number[]) {
  const parsed = parseSvgSource(text);
  if (!parsed.ok) return new Set<string>();
  return new Set(indices.flatMap(index => parsed.elements[index] ? svgElementSelectionKeys(parsed.elements[index]!) : [svgElementKey(index)]));
}

function isRendered(document: SvgParsedDocument, element: SvgSourceElement) {
  for (let parent = element.parentIndex; parent !== null; parent = document.elements[parent]?.parentIndex ?? null) {
    const name = document.elements[parent]!.name;
    if (NON_RENDERED.has(name.slice(name.indexOf(":") + 1))) return false;
  }
  return true;
}

export default function WorkbenchSvgCanvas({
  action,
  colors,
  document,
  grid,
  guides,
  onEdit,
  onEditSettled,
  onSelectionChange,
  onToolChange,
  selection,
  snap,
  text,
  tool,
}: {
  action: SvgCanvasAction | null;
  colors: boolean;
  document: SvgParsedDocument;
  grid: boolean;
  guides: boolean;
  onEdit: (next: string, options?: TextFileEditOptions) => void;
  onEditSettled: () => void;
  onSelectionChange: (keys: ReadonlySet<string>) => void;
  onToolChange: (tool: SvgCanvasTool) => void;
  selection: ReadonlySet<string>;
  /** Grid spacing points snap to while dragging; null drags freely. Alt drags freely for one gesture. */
  snap: number | null;
  text: string;
  tool: SvgCanvasTool;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const samplerRef = useRef<SVGPathElement>(null);
  const previewRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const penRef = useRef<PenDraft | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [marquee, setMarquee] = useState<{ from: SvgPoint; to: SvgPoint } | null>(null);
  const [pointer, setPointer] = useState<SvgPoint | null>(null);
  const [penPreview, setPenPreview] = useState<{ start: SvgPoint; last: SvgPoint } | null>(null);
  const root = document.root;
  const viewBox = useMemo(() => readSvgViewBox(root), [root]);
  const preserveAspectRatio = root.attributes.find(attribute => attribute.name === "preserveAspectRatio")?.value ?? "xMidYMid meet";

  const segmentsByElement = useMemo(() => {
    const map = new Map<number, SvgSegment[]>();
    for (const element of document.elements) {
      if (!SVG_SEGMENT_TAGS.has(element.name) || !isRendered(document, element)) continue;
      const segments = getSvgSegments(element);
      if (segments.length) map.set(element.index, segments);
    }
    return map;
  }, [document]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = window.document.createElement("style");
    style.textContent = PREVIEW_STYLE;
    const preview = buildSvgPreview(window.document, root);
    preview.setAttribute("preserveAspectRatio", preserveAspectRatio);
    shadow.replaceChildren(style, preview);
    previewRef.current = preview;
  }, [preserveAspectRatio, root]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const preview = previewRef.current;
    const sampler = samplerRef.current;
    const screen = overlay?.getScreenCTM();
    const rootScreen = preview?.getScreenCTM();
    if (!overlay || !preview || !sampler || !screen || !rootScreen || !size.width) return;
    const toRoot = rootScreen.inverse();
    const matrices = new Map<number, DOMMatrix>();
    const strokeWidths = new Map<number, number>();
    const rootSegments: SvgRootSegment[] = [];
    for (const [index, segments] of segmentsByElement) {
      const element = preview.querySelector(`[${SVG_SOURCE_INDEX_ATTRIBUTE}="${index}"]`);
      const elementScreen = element instanceof SVGGraphicsElement ? element.getScreenCTM() : null;
      if (!element || !elementScreen) continue;
      const matrix = toRoot.multiply(elementScreen);
      matrices.set(index, matrix);
      strokeWidths.set(index, Number.parseFloat(getComputedStyle(element).strokeWidth) || 1);
      const linearScale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
      for (const segment of segments) {
        sampler.setAttribute("d", segment.d);
        const total = sampler.getTotalLength();
        // Gap checks compare sample distances against 2 units, so samples must be much closer than that.
        const steps = Math.min(MAX_SAMPLES_PER_SEGMENT, Math.max(2, Math.ceil(total * linearScale / SAMPLE_SPACING_UNITS)));
        const samples = Array.from({ length: steps + 1 }, (_, step) => {
          const point = sampler.getPointAtLength(total * step / steps);
          return transform({ x: point.x, y: point.y }, matrix);
        });
        rootSegments.push({
          key: segment.key, elementIndex: index, kind: segment.kind,
          start: transform(segment.start, matrix), end: transform(segment.end, matrix),
          controls: segment.controls.map(point => transform(point, matrix)),
          circle: segment.circle ? { ...transform(segment.circle, matrix), r: segment.circle.r * linearScale,
            tangentIntersection: segment.circle.tangentIntersection ? transform(segment.circle.tangentIntersection, matrix) : null } : null,
          opensSubpath: segment.opensSubpath, closesSubpath: segment.closesSubpath, samples,
        });
      }
    }
    setMeasured({ scale: Math.hypot(screen.a, screen.b) || 1, matrices, strokeWidths, rootSegments });
  }, [segmentsByElement, root, size]);

  const scale = measured?.scale ?? 1;
  const analysis = useMemo(() => measured && guides ? analyzeSvgSegments(measured.rootSegments) : null, [guides, measured]);
  const gridPaths = useMemo(() => {
    if (!grid) return { minor: "", major: "" };
    const step = GRID_STEPS.find(candidate => candidate * scale >= MIN_GRID_PIXELS) ?? GRID_STEPS.at(-1)!;
    // Lucide's sub-grid: thirds of the canvas (12 on large canvases), else fifths.
    const size = Math.max(viewBox.width, viewBox.height);
    const majorEvery = size % 3 === 0 ? (size > 24 ? 12 : 3) : size % 5 === 0 ? 5 : 0;
    const minor: string[] = [];
    const major: string[] = [];
    const add = (offset: number, line: string) =>
      (majorEvery && step <= majorEvery && Math.abs(offset / majorEvery - Math.round(offset / majorEvery)) < 1e-9 ? major : minor).push(line);
    for (let x = Math.ceil(viewBox.x / step) * step; x <= viewBox.x + viewBox.width; x += step) add(x - viewBox.x, `M${x} ${viewBox.y}V${viewBox.y + viewBox.height}`);
    for (let y = Math.ceil(viewBox.y / step) * step; y <= viewBox.y + viewBox.height; y += step) add(y - viewBox.y, `M${viewBox.x} ${y}H${viewBox.x + viewBox.width}`);
    return { minor: minor.join(""), major: major.join("") };
  }, [grid, scale, viewBox]);

  const layers = useMemo((): SvgElementLayer[] => {
    if (!measured) return [];
    let colorOffset = 0;
    return [...segmentsByElement].flatMap(([index, segments]) => {
      const matrix = measured.matrices.get(index);
      if (!matrix) return [];
      const layer = { index, transform: matrixAttribute(matrix), strokeWidth: measured.strokeWidths.get(index) ?? 1, segments, colorOffset };
      colorOffset += segments.length;
      return [layer];
    });
  }, [measured, segmentsByElement]);

  const grouped = useMemo(() => groupSvgSelection(selection), [selection]);
  const handles = useMemo((): SvgOverlayHandle[] => {
    if (!measured || tool !== "select") return [];
    return [...grouped.keys()].flatMap(index => {
      const element = document.elements[index];
      const matrix = measured.matrices.get(index);
      const shape = element ? getSvgShape(element) : null;
      if (!element || !matrix || !shape) return [];
      return shape.handles.map(handle => ({
        key: `${index}:${handle.id}`, elementIndex: index, handleId: handle.id, kind: handle.kind,
        point: transform(handle.point, matrix), links: handle.links.map(link => transform(link, matrix)),
      }));
    });
  }, [document, grouped, measured, tool]);

  function clientToRoot(clientX: number, clientY: number) {
    const screen = overlayRef.current?.getScreenCTM();
    return screen ? transform({ x: clientX, y: clientY }, screen.inverse()) : { x: 0, y: 0 };
  }
  /** Snap to the nearest other endpoint or arc centre within reach, else to the grid; Alt or "Free" skip snapping. */
  function snapped(point: SvgPoint, free: boolean, exclude: ReadonlySet<number> = new Set()) {
    if (!snap || free) return point;
    let best: SvgPoint | null = null;
    let bestDistance = POINT_SNAP_UNITS;
    for (const segment of measured?.rootSegments ?? []) {
      if (exclude.has(segment.elementIndex)) continue;
      for (const candidate of [segment.start, segment.end, ...segment.circle ? [segment.circle] : []]) {
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance < bestDistance) { best = candidate; bestDistance = distance; }
      }
    }
    return best ? { x: best.x, y: best.y } : { x: Math.round(point.x / snap) * snap, y: Math.round(point.y / snap) * snap };
  }
  function localDelta(element: SvgSourceElement, delta: SvgPoint, origin: SvgPoint) {
    const matrix = measured?.matrices.get(element.index) ?? elementMatrix(element.index);
    if (!matrix) return delta;
    const inverse = matrix.inverse();
    const from = transform(origin, inverse);
    const to = transform({ x: origin.x + delta.x, y: origin.y + delta.y }, inverse);
    return { x: to.x - from.x, y: to.y - from.y };
  }
  function elementMatrix(index: number) {
    const target = previewRef.current?.querySelector(`[${SVG_SOURCE_INDEX_ATTRIBUTE}="${index}"]`);
    const elementScreen = target instanceof SVGGraphicsElement ? target.getScreenCTM() : null;
    const rootScreen = previewRef.current?.getScreenCTM();
    return elementScreen && rootScreen ? rootScreen.inverse().multiply(elementScreen) : null;
  }
  function selectionAnchor(keys: ReadonlySet<string>) {
    const rootSegment = measured?.rootSegments.find(segment => keys.has(segment.key));
    if (rootSegment) return rootSegment.start;
    for (const [index] of groupSvgSelection(keys)) {
      const element = document.elements[index];
      const handle = element ? getSvgShape(element)?.handles[0] : null;
      const matrix = elementMatrix(index);
      if (handle && matrix) return transform(handle.point, matrix);
    }
    return null;
  }
  function capture(event: PointerEvent) {
    frameRef.current?.focus({ preventScroll: true });
    frameRef.current?.setPointerCapture(event.pointerId);
  }

  function beginMove(event: PointerEvent, keys: ReadonlySet<string>, collapseTo: string | null) {
    const anchor = selectionAnchor(keys);
    if (!anchor) return;
    capture(event);
    dragRef.current = {
      kind: "move", pointerId: event.pointerId, key: `drag:${dragSequence += 1}`, text, document, selection: keys,
      startClient: { x: event.clientX, y: event.clientY }, startRoot: clientToRoot(event.clientX, event.clientY),
      anchorRoot: anchor, moved: false, collapseTo,
    };
  }

  function handleSegmentPointerDown(key: string, event: PointerEvent<SVGElement>) {
    if (event.button !== 0 || tool !== "select") return;
    event.stopPropagation();
    event.preventDefault();
    if (event.shiftKey) {
      // Lucide's gesture: with nothing selected, Shift-click takes the whole element; otherwise it toggles one segment.
      const element = document.elements[Number(key.split(":")[0])];
      if (!selection.size && element) {
        onSelectionChange(new Set(svgElementSelectionKeys(element)));
        return;
      }
      const next = new Set(selection);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange(next);
      return;
    }
    if (selection.has(key)) {
      beginMove(event, selection, selection.size > 1 ? key : null);
      return;
    }
    const next = new Set([key]);
    onSelectionChange(next);
    beginMove(event, next, null);
  }

  function handleSegmentDoubleClick(key: string) {
    const element = document.elements[Number(key.split(":")[0])];
    if (element) onSelectionChange(new Set(svgElementSelectionKeys(element)));
  }

  function handleHandlePointerDown(handle: SvgOverlayHandle, event: PointerEvent<SVGElement>) {
    const element = document.elements[handle.elementIndex];
    const matrix = measured?.matrices.get(handle.elementIndex) ?? elementMatrix(handle.elementIndex);
    if (event.button !== 0 || !element || !matrix) return;
    event.stopPropagation();
    event.preventDefault();
    capture(event);
    dragRef.current = {
      kind: "handle", pointerId: event.pointerId, key: `drag:${dragSequence += 1}`, text, element, handleId: handle.handleId,
      inverse: matrix.inverse(),
    };
  }

  function insertDrawn(markup: string, key: string) {
    const inserted = insertSvgMarkup(text, document, markup);
    if (!inserted) return null;
    onEdit(inserted.text, { coalesce: { key }, transient: true });
    return inserted.indices[0] ?? null;
  }

  function shapeMarkup(kind: "line" | "rect" | "circle", from: SvgPoint, to: SvgPoint) {
    if (kind === "line") return `<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" />`;
    if (kind === "circle") return `<circle cx="${n(from.x)}" cy="${n(from.y)}" r="${n(Math.hypot(to.x - from.x, to.y - from.y))}" />`;
    return `<rect x="${n(Math.min(from.x, to.x))}" y="${n(Math.min(from.y, to.y))}" width="${n(Math.abs(to.x - from.x))}" height="${n(Math.abs(to.y - from.y))}" rx="2" />`;
  }

  function writePen(pen: PenDraft, extra = "") {
    const element = document.elements[pen.elementIndex];
    if (!element) return;
    onEdit(applySvgAttributeEdits(text, element, [{ name: "d", value: pen.parts.join("") + extra }]),
      { coalesce: { key: pen.key }, transient: true });
  }

  function finishPen(close = false) {
    const pen = penRef.current;
    penRef.current = null;
    setPenPreview(null);
    if (!pen) return;
    const element = document.elements[pen.elementIndex];
    if (!element) return;
    if (pen.parts.length < 2) {
      onEdit(deleteSvgSelection(text, document, new Map([[pen.elementIndex, null]])), { coalesce: { key: pen.key }, transient: true });
    } else {
      if (close) writePen(pen, "Z");
      onSelectionChange(new Set(svgElementSelectionKeys(element)));
    }
    onEditSettled();
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    frameRef.current?.focus({ preventScroll: true });
    const point = clientToRoot(event.clientX, event.clientY);
    const at = snapped(point, event.altKey);
    if (tool === "pen") {
      event.preventDefault();
      capture(event);
      const pen = penRef.current;
      if (pen && pen.parts.length > 1 && Math.hypot(at.x - pen.start.x, at.y - pen.start.y) * scale < CLOSE_PATH_PIXELS) {
        finishPen(true);
        return;
      }
      if (!pen) {
        const key = `pen:${dragSequence += 1}`;
        const index = insertDrawn(`<path d="M${n(at.x)} ${n(at.y)}" />`, key);
        if (index === null) return;
        penRef.current = { elementIndex: index, parts: [`M${n(at.x)} ${n(at.y)}`], start: at, last: at, handle: null, pendingHandle: null, key };
        setPenPreview({ start: at, last: at });
      } else {
        pen.parts.push(`L${n(at.x)} ${n(at.y)}`);
        writePen(pen);
        pen.last = at;
        pen.handle = null;
        setPenPreview({ start: pen.start, last: at });
      }
      dragRef.current = { kind: "pen", pointerId: event.pointerId, at, startClient: { x: event.clientX, y: event.clientY } };
      return;
    }
    if (tool !== "select") {
      event.preventDefault();
      capture(event);
      dragRef.current = { kind: "shape", pointerId: event.pointerId, key: `draw:${dragSequence += 1}`, text, document, tool, from: at, elementIndex: null };
      return;
    }
    let index: number | null = null;
    for (const node of event.nativeEvent.composedPath()) {
      if (node instanceof Element && node.hasAttribute(SVG_SOURCE_INDEX_ATTRIBUTE)) {
        index = Number(node.getAttribute(SVG_SOURCE_INDEX_ATTRIBUTE));
        break;
      }
    }
    const element = index !== null && index > 0 ? document.elements[index] ?? null : null;
    if (element) {
      event.preventDefault();
      const keys = svgElementSelectionKeys(element);
      if (event.shiftKey) {
        const next = new Set(selection);
        const all = keys.every(key => next.has(key));
        for (const key of keys) { if (all) next.delete(key); else next.add(key); }
        onSelectionChange(next);
        return;
      }
      const next = keys.some(key => selection.has(key)) ? selection : new Set(keys);
      if (next !== selection) onSelectionChange(next);
      beginMove(event, next, null);
      return;
    }
    event.preventDefault();
    capture(event);
    dragRef.current = { kind: "marquee", pointerId: event.pointerId, from: point, to: point, additive: event.shiftKey,
      startClient: { x: event.clientX, y: event.clientY }, moved: false };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const point = clientToRoot(event.clientX, event.clientY);
    if (tool !== "select") setPointer(snapped(point, event.altKey));
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    switch (drag.kind) {
      case "handle": {
        const shape = getSvgShape(drag.element);
        if (!shape) return;
        const local = transform(snapped(point, event.altKey, new Set([drag.element.index])), drag.inverse);
        onEdit(applySvgAttributeEdits(drag.text, drag.element, shape.move(drag.handleId, local)), { coalesce: { key: drag.key }, transient: true });
        return;
      }
      case "move": {
        if (!drag.moved && Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < DRAG_THRESHOLD_PIXELS) return;
        drag.moved = true;
        const target = snapped({ x: drag.anchorRoot.x + point.x - drag.startRoot.x, y: drag.anchorRoot.y + point.y - drag.startRoot.y },
          event.altKey, new Set(groupSvgSelection(drag.selection).keys()));
        const delta = { x: target.x - drag.anchorRoot.x, y: target.y - drag.anchorRoot.y };
        onEdit(moveSvgSelection(drag.text, drag.document, groupSvgSelection(drag.selection),
          element => localDelta(element, delta, drag.anchorRoot)), { coalesce: { key: drag.key }, transient: true });
        return;
      }
      case "marquee": {
        if (!drag.moved && Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < DRAG_THRESHOLD_PIXELS) return;
        drag.moved = true;
        drag.to = point;
        setMarquee({ from: drag.from, to: point });
        return;
      }
      case "shape": {
        const to = snapped(point, event.altKey);
        if (to.x === drag.from.x && to.y === drag.from.y) return;
        const inserted = insertSvgMarkup(drag.text, drag.document, shapeMarkup(drag.tool, drag.from, to));
        if (!inserted) return;
        drag.elementIndex = inserted.indices[0] ?? null;
        onEdit(inserted.text, { coalesce: { key: drag.key }, transient: true });
        return;
      }
      case "pen": {
        const pen = penRef.current;
        if (!pen || Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < DRAG_THRESHOLD_PIXELS) return;
        const handle = { x: point.x - drag.at.x, y: point.y - drag.at.y };
        if (pen.parts.length > 1) {
          const previous = penAnchor(pen.parts.slice(0, -1));
          const cp1 = pen.handle ? { x: previous.x + pen.handle.x, y: previous.y + pen.handle.y } : previous;
          const cp2 = { x: drag.at.x - handle.x, y: drag.at.y - handle.y };
          pen.parts[pen.parts.length - 1] = `C${n(cp1.x)} ${n(cp1.y)} ${n(cp2.x)} ${n(cp2.y)} ${n(drag.at.x)} ${n(drag.at.y)}`;
          writePen(pen);
        }
        pen.pendingHandle = handle;
        return;
      }
    }
  }

  function penAnchor(parts: readonly string[]) {
    const numbers = (parts.at(-1) ?? "").match(/-?[\d.]+/gu)?.map(Number) ?? [0, 0];
    return { x: numbers.at(-2) ?? 0, y: numbers.at(-1) ?? 0 };
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (frameRef.current?.hasPointerCapture(event.pointerId)) frameRef.current.releasePointerCapture(event.pointerId);
    switch (drag.kind) {
      case "handle": onEditSettled(); return;
      case "move":
        if (drag.moved) onEditSettled();
        else if (drag.collapseTo) onSelectionChange(new Set([drag.collapseTo]));
        return;
      case "marquee": {
        setMarquee(null);
        if (!drag.moved) {
          if (!drag.additive) onSelectionChange(new Set());
          return;
        }
        const left = Math.min(drag.from.x, drag.to.x);
        const right = Math.max(drag.from.x, drag.to.x);
        const top = Math.min(drag.from.y, drag.to.y);
        const bottom = Math.max(drag.from.y, drag.to.y);
        const inside = (point: SvgPoint) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
        const next = new Set(drag.additive ? selection : []);
        for (const segment of measured?.rootSegments ?? []) {
          if (inside(segment.start) && inside(segment.end) && segment.samples.every(inside)) next.add(segment.key);
        }
        onSelectionChange(next);
        return;
      }
      case "shape":
        if (drag.elementIndex !== null) {
          onEditSettled();
          onSelectionChange(new Set([`${drag.elementIndex}:0`]));
          onToolChange("select");
        }
        return;
      case "pen": {
        const pen = penRef.current;
        if (!pen) return;
        pen.handle = pen.pendingHandle;
        pen.pendingHandle = null;
        return;
      }
    }
  }

  function edit(next: string | null, keys?: ReadonlySet<string>) {
    if (next === null || next === text) return;
    onEdit(next);
    if (keys) onSelectionChange(keys);
  }

  function runAction(command: SvgCanvasAction | SvgCanvasAction["kind"]) {
    const kind = typeof command === "string" ? command : command.kind;
    const selected = groupSvgSelection(selection);
    const center = { x: viewBox.x + viewBox.width / 2, y: viewBox.y + viewBox.height / 2 };
    switch (kind) {
      case "resize-canvas": {
        if (typeof command === "string" || command.kind !== "resize-canvas" || command.width <= 0 || command.height <= 0) return;
        const factor = command.width / viewBox.width;
        const scaled = command.scaleContent
          ? transformSvgSelection(text, document, null, point => ({
            x: viewBox.x + (point.x - viewBox.x) * factor, y: viewBox.y + (point.y - viewBox.y) * factor,
          }), { mirrored: false, scale: factor })
          : text;
        const reparsed = parseSvgSource(scaled);
        if (!reparsed.ok) return;
        const sized = (name: string, value: number) => reparsed.root.attributes.some(attribute => attribute.name === name)
          ? [{ name, value: n(value) }] : [];
        edit(applySvgAttributeEdits(scaled, reparsed.root, [
          { name: "viewBox", value: `${n(viewBox.x)} ${n(viewBox.y)} ${n(command.width)} ${n(command.height)}` },
          ...sized("width", command.width), ...sized("height", command.height),
        ]));
        return;
      }
      case "delete":
        if (selected.size) edit(deleteSvgSelection(text, document, selected), new Set());
        return;
      case "duplicate": {
        const copied = selected.size ? duplicateSvgSelection(text, document, selected) : null;
        if (copied) edit(copied.text, keysForInserted(copied.text, copied.indices));
        return;
      }
      case "flip-horizontal":
      case "flip-vertical": {
        const horizontal = kind === "flip-horizontal";
        edit(transformSvgSelection(text, document, selected.size ? selected : null, point => horizontal
          ? { x: 2 * center.x - point.x, y: point.y } : { x: point.x, y: 2 * center.y - point.y }, { mirrored: true, scale: 1 }));
        return;
      }
      case "circlify": {
        let next = text;
        for (const element of [...selected.keys()].map(index => document.elements[index]!).sort((a, b) => b.start - a.start)) {
          const indices = selected.get(element.index);
          if (indices) next = circlifySvgSegments(next, element, indices) ?? next;
        }
        edit(next, new Set());
        return;
      }
    }
  }

  const lastAction = useRef<number | null>(null);
  useEffect(() => {
    if (!action || lastAction.current === action.id) return;
    lastAction.current = action.id;
    runAction(action);
  });

  useEffect(() => {
    if (tool !== "pen" && penRef.current) finishPen();
    if (tool === "select") setPointer(null);
  }, [tool]);

  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (window.document.activeElement !== frameRef.current || !selection.size || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", svgSelectionMarkup(text, document, groupSvgSelection(selection)));
      if (event.type === "cut") edit(deleteSvgSelection(text, document, groupSvgSelection(selection)), new Set());
    };
    const onPaste = (event: ClipboardEvent) => {
      if (window.document.activeElement !== frameRef.current || !event.clipboardData) return;
      const markup = event.clipboardData.getData("text/plain");
      const file = [...event.clipboardData.files].find(item => item.type === "image/svg+xml" || item.name.endsWith(".svg"));
      event.preventDefault();
      const insert = (value: string) => {
        const inserted = insertSvgMarkup(text, document, value);
        if (inserted) edit(inserted.text, keysForInserted(inserted.text, inserted.indices));
      };
      if (file) void file.text().then(insert);
      else if (markup) insert(markup);
    };
    window.document.addEventListener("copy", onCopy);
    window.document.addEventListener("cut", onCopy);
    window.document.addEventListener("paste", onPaste);
    return () => {
      window.document.removeEventListener("copy", onCopy);
      window.document.removeEventListener("cut", onCopy);
      window.document.removeEventListener("paste", onPaste);
    };
  });

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!modifier && !event.altKey && TOOL_KEYS[key]) {
      event.preventDefault();
      onToolChange(TOOL_KEYS[key]!);
      return;
    }
    if (event.key === "Enter" && penRef.current) { event.preventDefault(); finishPen(); return; }
    if (event.key === "Escape") {
      if (penRef.current) finishPen();
      else if (tool !== "select") onToolChange("select");
      else onSelectionChange(new Set());
      return;
    }
    if (modifier && key === "a") {
      event.preventDefault();
      onSelectionChange(new Set(document.elements.filter(element => element.index > 0 && element.parentIndex === root.index)
        .flatMap(element => svgElementSelectionKeys(element))));
      return;
    }
    if (!selection.size) return;
    const arrows: Record<string, SvgPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const arrow = arrows[event.key];
    if (arrow && !modifier) {
      event.preventDefault();
      const step = (snap ?? 1) * (event.shiftKey ? 10 : 1);
      const delta = { x: arrow.x * step, y: arrow.y * step };
      const anchor = selectionAnchor(selection) ?? { x: 0, y: 0 };
      onEdit(moveSvgSelection(text, document, groupSvgSelection(selection), element => localDelta(element, delta, anchor)),
        { coalesce: { key: "nudge", windowMs: NUDGE_COALESCE_MS } });
    } else if ((event.key === "Delete" || event.key === "Backspace") && !modifier) {
      event.preventDefault();
      runAction("delete");
    } else if (modifier && key === "d") {
      event.preventDefault();
      runAction("duplicate");
    }
  }

  const unit = 1 / scale;
  let draft: ReactNode = null;
  if (penPreview && pointer) {
    draft = <g pointerEvents="none">
      <line x1={penPreview.last.x} y1={penPreview.last.y} x2={pointer.x} y2={pointer.y} stroke="var(--accent)" strokeDasharray="4 3"
        strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <circle cx={penPreview.start.x} cy={penPreview.start.y} r={4 * unit} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </g>;
  } else if (pointer && tool !== "select") {
    draft = <circle cx={pointer.x} cy={pointer.y} r={3 * unit} fill="var(--accent)" fillOpacity={0.6} pointerEvents="none" />;
  }

  return (
    <div
      ref={frameRef}
      aria-label="SVG canvas. Click segments to select, Shift adds, double-click selects a shape, drag empty space to box-select. Tools: V select, P pen, L line, R rect, C circle."
      className={`
        relative size-full touch-none select-none overflow-hidden rounded-[1rem] outline-none
        focus-visible:ring-2 focus-visible:ring-accent-soft
        text-text
        ${tool === "select" ? "" : "cursor-crosshair"}
      `}
      onDoubleClick={() => { if (penRef.current) finishPen(); }}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerLeave={() => setPointer(null)}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      role="application"
      tabIndex={0}
    >
      <div ref={hostRef} className="absolute inset-6" />
      <svg
        ref={overlayRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-6 size-[calc(100%-3rem)] overflow-visible"
        preserveAspectRatio={preserveAspectRatio}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      >
        <path ref={samplerRef} visibility="hidden" />
        <WorkbenchSvgCanvasOverlay
          analysis={analysis}
          colors={colors}
          draft={draft}
          grid={gridPaths}
          guides={guides}
          handles={handles}
          interactive={tool === "select"}
          layers={layers}
          marquee={marquee}
          onHandlePointerDown={handleHandlePointerDown}
          onSegmentDoubleClick={handleSegmentDoubleClick}
          onSegmentPointerDown={handleSegmentPointerDown}
          rootSegments={measured?.rootSegments ?? []}
          scale={scale}
          selection={selection}
          viewBox={viewBox}
        />
      </svg>
    </div>
  );
}
