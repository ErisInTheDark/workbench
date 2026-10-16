/*
 * Exports:
 * - SvgCanvasBackground: preview backdrop choices.
 * - default WorkbenchSvgCanvas: isolated live SVG preview with grid, selection, draggable points, element moves and keyboard edits.
 */
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { TextFileEditOptions } from "../../../workbench/file/TextFileDocumentController";
import { getSvgShape, type SvgShape } from "../../../workbench/svg/svg-geometry";
import type { SvgPoint } from "../../../workbench/svg/svg-path-data";
import { buildSvgPreview, readSvgViewBox, SVG_SOURCE_INDEX_ATTRIBUTE } from "../../../workbench/svg/svg-preview-dom";
import { applySvgAttributeEdits, duplicateSvgElement, removeSvgElement } from "../../../workbench/svg/svg-source-edits";
import type { SvgSourceElement } from "../../../workbench/svg/svg-source";

export type SvgCanvasBackground = "checker" | "light" | "dark";

const PREVIEW_STYLE = `
  :host { display: block; }
  svg[${SVG_SOURCE_INDEX_ATTRIBUTE}="0"] { display: block; width: 100%; height: 100%; }
  :is(path, line, polyline, polygon, circle, rect, ellipse, text, use, image)[${SVG_SOURCE_INDEX_ATTRIBUTE}] { pointer-events: all; cursor: pointer; }
`;
const GRID_STEPS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const MIN_GRID_PIXELS = 7;
const DRAG_THRESHOLD_PIXELS = 3;
const NUDGE_COALESCE_MS = 800;
const HANDLE_PIXELS = 5;
const HANDLE_COLOR = "var(--accent)";
const HANDLE_FILL = "#fff";

const BACKGROUND_CLASS_NAMES: Record<SvgCanvasBackground, string> = {
  checker: `
    text-text
    bg-[repeating-conic-gradient(color-mix(in srgb, var(--text) 7%, transparent) 0 25%, transparent 0 50%)]
    bg-[length:1rem_1rem]
  `,
  dark: "bg-[#17161b] text-[#f4f1ea]",
  light: "bg-white text-[#17161b]",
};

type Drag =
  | { kind: "handle"; pointerId: number; key: string; text: string; element: SvgSourceElement; shape: SvgShape; handleId: string; inverse: DOMMatrix }
  | {
    kind: "move"; pointerId: number; key: string; text: string; element: SvgSourceElement; shape: SvgShape; inverse: DOMMatrix;
    startClient: SvgPoint; startRoot: SvgPoint; anchorRoot: SvgPoint; moved: boolean;
  };

interface CanvasLayout {
  scale: number;
  selection: { index: number; matrix: DOMMatrix; box: SvgPoint[] | null } | null;
}

let dragSequence = 0;

const transform = (point: SvgPoint, matrix: DOMMatrix) => {
  const next = new DOMPoint(point.x, point.y).matrixTransform(matrix);
  return { x: next.x, y: next.y };
};

function subtreeSize(elements: readonly SvgSourceElement[], element: SvgSourceElement) {
  return elements.filter(item => item.start >= element.start && item.end <= element.end).length;
}

export default function WorkbenchSvgCanvas({
  background,
  elements,
  grid,
  onEdit,
  onEditSettled,
  onSelect,
  root,
  selectedIndex,
  snap,
  text,
}: {
  background: SvgCanvasBackground;
  elements: readonly SvgSourceElement[];
  grid: boolean;
  onEdit: (next: string, options?: TextFileEditOptions) => void;
  onEditSettled: () => void;
  onSelect: (index: number | null) => void;
  root: SvgSourceElement;
  selectedIndex: number | null;
  /** Grid spacing points snap to while dragging; null drags freely. Alt drags freely for one gesture. */
  snap: number | null;
  text: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const previewRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<CanvasLayout | null>(null);
  const viewBox = useMemo(() => readSvgViewBox(root), [root]);
  const preserveAspectRatio = root.attributes.find(attribute => attribute.name === "preserveAspectRatio")?.value ?? "xMidYMid meet";
  const selected = selectedIndex !== null && selectedIndex > 0 ? elements[selectedIndex] ?? null : null;
  const shape = useMemo(() => selected ? getSvgShape(selected) : null, [selected]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PREVIEW_STYLE;
    const preview = buildSvgPreview(document, root);
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
    const screen = overlay?.getScreenCTM();
    if (!overlay || !preview || !screen) return;
    let selection: CanvasLayout["selection"] = null;
    const element = selectedIndex !== null && selectedIndex > 0
      ? preview.querySelector(`[${SVG_SOURCE_INDEX_ATTRIBUTE}="${selectedIndex}"]`) : null;
    const elementScreen = element instanceof SVGGraphicsElement ? element.getScreenCTM() : null;
    const rootScreen = preview.getScreenCTM();
    if (element instanceof SVGGraphicsElement && elementScreen && rootScreen && selectedIndex !== null) {
      const matrix = rootScreen.inverse().multiply(elementScreen);
      let box: SvgPoint[] | null = null;
      try {
        const bounds = element.getBBox();
        box = [
          { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
        ].map(point => transform(point, matrix));
      } catch {
        // Unrendered elements have no box; their handles still show.
      }
      selection = { index: selectedIndex, matrix, box };
    }
    setLayout({ scale: Math.hypot(screen.a, screen.b) || 1, selection });
  }, [root, selectedIndex, size]);

  const scale = layout?.scale ?? 1;
  const gridPath = useMemo(() => {
    if (!grid) return "";
    const step = GRID_STEPS.find(candidate => candidate * scale >= MIN_GRID_PIXELS) ?? GRID_STEPS.at(-1)!;
    const lines: string[] = [];
    for (let x = Math.ceil(viewBox.x / step) * step; x <= viewBox.x + viewBox.width; x += step) {
      lines.push(`M${x} ${viewBox.y}V${viewBox.y + viewBox.height}`);
    }
    for (let y = Math.ceil(viewBox.y / step) * step; y <= viewBox.y + viewBox.height; y += step) {
      lines.push(`M${viewBox.x} ${y}H${viewBox.x + viewBox.width}`);
    }
    return lines.join("");
  }, [grid, scale, viewBox]);

  const matrix = layout?.selection?.index === selectedIndex ? layout.selection.matrix : null;
  const handles = matrix && shape ? shape.handles.map(handle => ({
    ...handle, root: transform(handle.point, matrix), links: handle.links.map(link => transform(link, matrix)),
  })) : [];

  function clientToRoot(clientX: number, clientY: number) {
    const screen = overlayRef.current?.getScreenCTM();
    return screen ? transform({ x: clientX, y: clientY }, screen.inverse()) : { x: 0, y: 0 };
  }

  function snapped(point: SvgPoint, free: boolean) {
    if (!snap || free) return point;
    return { x: Math.round(point.x / snap) * snap, y: Math.round(point.y / snap) * snap };
  }

  function localDelta(delta: SvgPoint, origin: SvgPoint, inverse: DOMMatrix) {
    const from = transform(origin, inverse);
    const to = transform({ x: origin.x + delta.x, y: origin.y + delta.y }, inverse);
    return { x: to.x - from.x, y: to.y - from.y };
  }

  function beginHandleDrag(event: PointerEvent<SVGElement>, handleId: string) {
    if (!selected || !shape || !matrix || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    frameRef.current?.focus({ preventScroll: true });
    frameRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "handle", pointerId: event.pointerId, key: `drag:${dragSequence += 1}`, text, element: selected, shape, handleId,
      inverse: matrix.inverse(),
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    frameRef.current?.focus({ preventScroll: true });
    let index: number | null = null;
    for (const node of event.nativeEvent.composedPath()) {
      if (node instanceof Element && node.hasAttribute(SVG_SOURCE_INDEX_ATTRIBUTE)) {
        index = Number(node.getAttribute(SVG_SOURCE_INDEX_ATTRIBUTE));
        break;
      }
    }
    const element = index !== null && index > 0 ? elements[index] ?? null : null;
    onSelect(element ? element.index : null);
    const elementShape = element ? getSvgShape(element) : null;
    const target = element ? previewRef.current?.querySelector(`[${SVG_SOURCE_INDEX_ATTRIBUTE}="${element.index}"]`) : null;
    const elementScreen = target instanceof SVGGraphicsElement ? target.getScreenCTM() : null;
    const rootScreen = previewRef.current?.getScreenCTM();
    if (!element || !elementShape?.handles[0] || !elementScreen || !rootScreen) return;
    event.preventDefault();
    const local = rootScreen.inverse().multiply(elementScreen);
    frameRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "move", pointerId: event.pointerId, key: `drag:${dragSequence += 1}`, text, element, shape: elementShape,
      inverse: local.inverse(), startClient: { x: event.clientX, y: event.clientY },
      startRoot: clientToRoot(event.clientX, event.clientY), anchorRoot: transform(elementShape.handles[0].point, local), moved: false,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "handle") {
      const local = transform(snapped(clientToRoot(event.clientX, event.clientY), event.altKey), drag.inverse);
      onEdit(applySvgAttributeEdits(drag.text, drag.element, drag.shape.move(drag.handleId, local)),
        { coalesce: { key: drag.key }, transient: true });
      return;
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < DRAG_THRESHOLD_PIXELS) return;
    drag.moved = true;
    const pointer = clientToRoot(event.clientX, event.clientY);
    const target = snapped({
      x: drag.anchorRoot.x + pointer.x - drag.startRoot.x,
      y: drag.anchorRoot.y + pointer.y - drag.startRoot.y,
    }, event.altKey);
    const delta = localDelta({ x: target.x - drag.anchorRoot.x, y: target.y - drag.anchorRoot.y }, drag.anchorRoot, drag.inverse);
    onEdit(applySvgAttributeEdits(drag.text, drag.element, drag.shape.translate(delta)),
      { coalesce: { key: drag.key }, transient: true });
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (frameRef.current?.hasPointerCapture(event.pointerId)) frameRef.current.releasePointerCapture(event.pointerId);
    if (drag.kind === "handle" || drag.moved) onEditSettled();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!selected) return;
    const modifier = event.ctrlKey || event.metaKey;
    const arrows: Record<string, SvgPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const arrow = arrows[event.key];
    if (arrow && !modifier && shape && matrix) {
      event.preventDefault();
      const step = (snap ?? 1) * (event.shiftKey ? 10 : 1);
      const origin = transform(shape.handles[0]?.point ?? { x: 0, y: 0 }, matrix);
      const delta = localDelta({ x: arrow.x * step, y: arrow.y * step }, origin, matrix.inverse());
      onEdit(applySvgAttributeEdits(text, selected, shape.translate(delta)), { coalesce: { key: "nudge", windowMs: NUDGE_COALESCE_MS } });
    } else if ((event.key === "Delete" || event.key === "Backspace") && !modifier) {
      event.preventDefault();
      onSelect(null);
      onEdit(removeSvgElement(text, selected));
    } else if (modifier && event.key.toLowerCase() === "d") {
      event.preventDefault();
      onEdit(duplicateSvgElement(text, selected).text);
      onSelect(selected.index + subtreeSize(elements, selected));
    } else if (event.key === "Escape") {
      onSelect(null);
    }
  }

  const unit = 1 / scale;
  const box = layout?.selection?.index === selectedIndex ? layout.selection.box : null;
  return (
    <div
      ref={frameRef}
      aria-label="SVG preview. Click a shape to select it, drag points to edit, arrow keys nudge, Delete removes, Ctrl+D duplicates."
      className={`
        relative size-full touch-none select-none overflow-hidden rounded-[1rem] outline-none
        focus-visible:ring-2 focus-visible:ring-accent-soft
        ${BACKGROUND_CLASS_NAMES[background]}
      `}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
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
        {gridPath ? <path d={gridPath} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={1}
          vectorEffect="non-scaling-stroke" /> : null}
        <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="none"
          stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {box ? <polygon points={box.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke={HANDLE_COLOR}
          strokeOpacity={0.8} strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
        {handles.flatMap(handle => handle.links.map((link, index) => <line key={`${handle.id}:link:${index}`}
          x1={link.x} y1={link.y} x2={handle.root.x} y2={handle.root.y}
          stroke={HANDLE_COLOR} strokeOpacity={0.7} strokeWidth={1} vectorEffect="non-scaling-stroke" />))}
        {handles.map(handle => handle.kind === "radius"
          ? <rect key={handle.id} className="pointer-events-auto cursor-grab active:cursor-grabbing"
            x={handle.root.x - HANDLE_PIXELS * unit} y={handle.root.y - HANDLE_PIXELS * unit}
            width={HANDLE_PIXELS * 2 * unit} height={HANDLE_PIXELS * 2 * unit}
            transform={`rotate(45 ${handle.root.x} ${handle.root.y})`}
            fill={HANDLE_FILL} stroke={HANDLE_COLOR} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
            onPointerDown={event => beginHandleDrag(event, handle.id)} />
          : <circle key={handle.id} className="pointer-events-auto cursor-grab active:cursor-grabbing"
            cx={handle.root.x} cy={handle.root.y} r={(handle.kind === "control" ? HANDLE_PIXELS - 1 : HANDLE_PIXELS) * unit}
            fill={handle.kind === "control" ? HANDLE_FILL : HANDLE_COLOR} stroke={handle.kind === "control" ? HANDLE_COLOR : HANDLE_FILL}
            strokeWidth={1.5} vectorEffect="non-scaling-stroke"
            onPointerDown={event => beginHandleDrag(event, handle.id)} />)}
      </svg>
    </div>
  );
}
