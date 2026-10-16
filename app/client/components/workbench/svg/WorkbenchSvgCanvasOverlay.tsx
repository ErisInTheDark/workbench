/*
 * Exports:
 * - SvgElementLayer: one element's segments with its local-to-root transform and stroke width.
 * - SvgOverlayHandle: one draggable point in root space.
 * - default WorkbenchSvgCanvasOverlay: grid, coloured segments with lucide-style control paths and joint rings, guides, violations,
 *   hit targets, ring handles, marquee and drawing preview.
 */
"use client";

import { useId, type PointerEvent, type ReactNode } from "react";
import type { SvgAnalysis, SvgRootSegment } from "../../../workbench/svg/svg-analysis";
import { SVG_SEGMENT_PALETTE } from "../../../workbench/svg/svg-highlights";
import type { SvgPoint } from "../../../workbench/svg/svg-path-data";
import type { SvgViewBox } from "../../../workbench/svg/svg-preview-dom";
import type { SvgSegment } from "../../../workbench/svg/svg-segments";

export interface SvgElementLayer {
  index: number;
  transform: string;
  strokeWidth: number;
  segments: SvgSegment[];
  colorOffset: number;
}

export interface SvgOverlayHandle {
  key: string;
  elementIndex: number;
  handleId: string;
  kind: "anchor" | "control" | "radius";
  point: SvgPoint;
  links: SvgPoint[];
}

/** Every distinct segment start and end, in local coordinates; whole primitives have none. */
function jointPoints(segments: readonly SvgSegment[]) {
  const points: SvgPoint[] = [];
  for (const segment of segments) {
    if (segment.kind === "shape") continue;
    for (const point of [segment.start, segment.end]) {
      if (!points.some(existing => Math.abs(existing.x - point.x) < 1e-6 && Math.abs(existing.y - point.y) < 1e-6)) points.push(point);
    }
  }
  return points;
}

const ACCENT = "var(--accent)";
const DANGER = "#ef4444";
const SUGGESTION = "#22c55e";
const SHADOW = "#777";
/** Same size as a joint ring on a 2-wide stroke, so a near-miss covers the end it flags. */
const SNAP_MARKER_UNITS = 0.5;
const HANDLE_PIXELS = 5;
const HIT_PIXELS = 12;

export default function WorkbenchSvgCanvasOverlay({
  analysis,
  colors,
  draft,
  grid,
  guides,
  handles,
  interactive,
  layers,
  marquee,
  onHandlePointerDown,
  onSegmentDoubleClick,
  onSegmentPointerDown,
  rootSegments,
  scale,
  selection,
  viewBox,
}: {
  analysis: SvgAnalysis | null;
  colors: boolean;
  draft: ReactNode;
  /** Unit (or zoom-appropriate) lines and the lucide sub-grid lines. */
  grid: { minor: string; major: string };
  guides: boolean;
  handles: readonly SvgOverlayHandle[];
  interactive: boolean;
  layers: readonly SvgElementLayer[];
  marquee: { from: SvgPoint; to: SvgPoint } | null;
  onHandlePointerDown: (handle: SvgOverlayHandle, event: PointerEvent<SVGElement>) => void;
  onSegmentDoubleClick: (key: string) => void;
  onSegmentPointerDown: (key: string, event: PointerEvent<SVGElement>) => void;
  rootSegments: readonly SvgRootSegment[];
  scale: number;
  selection: ReadonlySet<string>;
  viewBox: SvgViewBox;
}) {
  const id = useId().replace(/:/gu, "");
  const unit = 1 / scale;
  const elementSamples = new Map<number, SvgPoint[]>();
  for (const segment of rootSegments) {
    elementSamples.set(segment.elementIndex, [...elementSamples.get(segment.elementIndex) ?? [], ...segment.samples]);
  }
  const groupPath = (indices: readonly number[]) => layers.filter(layer => indices.includes(layer.index))
    .flatMap(layer => layer.segments.map(segment => ({ d: segment.d, transform: layer.transform })));
  const gapPairs = analysis && guides
    ? analysis.gapGroups.flatMap((group, index) => analysis.gapGroups.slice(0, index).map(other => [group, other] as const)).slice(0, 40)
    : [];
  // Selected elements draw (and take pointer hits) above everything else, so their joints are never covered.
  const selectedElements = new Set([...selection].map(key => Number(key.split(":")[0])));
  const stacked = [...layers.filter(layer => !selectedElements.has(layer.index)), ...layers.filter(layer => selectedElements.has(layer.index))];
  const inner = { x: viewBox.x + 1, y: viewBox.y + 1, width: Math.max(0, viewBox.width - 2), height: Math.max(0, viewBox.height - 2) };

  return (
    <>
      <defs>
        <pattern id={`${id}-hatch`} width={4 * unit} height={4 * unit} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line y2={4 * unit} stroke={DANGER} strokeWidth={1.5 * unit} />
        </pattern>
        <mask id={`${id}-border`} maskUnits="userSpaceOnUse">
          <rect x={viewBox.x - viewBox.width} y={viewBox.y - viewBox.height} width={viewBox.width * 3} height={viewBox.height * 3} fill="white" />
          <rect x={inner.x} y={inner.y} width={inner.width} height={inner.height} rx={1} fill="black" />
        </mask>
        {gapPairs.map(([, other], index) => (
          <mask key={index} id={`${id}-gap-${index}`} maskUnits="userSpaceOnUse">
            {groupPath(other).map((item, position) => (
              <path key={position} d={item.d} transform={item.transform} fill="none" stroke="white" strokeWidth={4} strokeLinecap="round" />
            ))}
          </mask>
        ))}
      </defs>

      {grid.minor ? <path d={grid.minor} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
      {grid.major ? <path d={grid.major} fill="none" stroke="currentColor" strokeOpacity={0.24} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
      <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="none"
        stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {guides ? <rect x={inner.x} y={inner.y} width={inner.width} height={inner.height} rx={1} fill="none"
        stroke="currentColor" strokeOpacity={0.12} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}

      {guides ? (
        <g mask={`url(#${id}-border)`} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {layers.map(layer => (
            <g key={layer.index} transform={layer.transform}>
              {layer.segments.map(segment => <path key={segment.key} d={segment.d} stroke={`url(#${id}-hatch)`} strokeWidth={layer.strokeWidth} />)}
            </g>
          ))}
        </g>
      ) : null}
      {gapPairs.map(([group], index) => (
        <g key={index} mask={`url(#${id}-gap-${index})`} fill="none" strokeLinecap="round">
          {groupPath(group).map((item, position) => (
            <path key={position} d={item.d} transform={item.transform} stroke={`url(#${id}-hatch)`} strokeWidth={4} />
          ))}
        </g>
      ))}

      {guides ? layers.map(layer => (
        <g key={layer.index} transform={layer.transform} fill="none" stroke={SHADOW} strokeOpacity={0.15} strokeLinecap="round"
          strokeLinejoin="round" strokeWidth={layer.strokeWidth + 2} pointerEvents="none">
          {layer.segments.map(segment => <path key={segment.key} d={segment.d} />)}
        </g>
      )) : null}

      {colors ? stacked.map(layer => (
        <g key={layer.index} transform={layer.transform} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {layer.segments.map((segment, position) => (
            <path key={segment.key} d={segment.d} strokeWidth={layer.strokeWidth}
              stroke={SVG_SEGMENT_PALETTE[(layer.colorOffset + position) % SVG_SEGMENT_PALETTE.length]!.stroke} />
          ))}
        </g>
      )) : null}

      {guides ? stacked.map(layer => {
        // Lucide's control path: a white centreline, broken by a white ring at every joint and open end.
        const ring = layer.strokeWidth / 4;
        const line = layer.strokeWidth / 16;
        const joints = jointPoints(layer.segments);
        return (
          <g key={layer.index} transform={layer.transform} fill="none" stroke="#fff" pointerEvents="none">
            <mask id={`${id}-joints-${layer.index}`} maskUnits="userSpaceOnUse" x={-1e4} y={-1e4} width={2e4} height={2e4}>
              <rect x={-1e4} y={-1e4} width={2e4} height={2e4} fill="white" />
              {joints.map((point, position) => <circle key={position} cx={point.x} cy={point.y} r={ring} fill="black" />)}
            </mask>
            <g mask={`url(#${id}-joints-${layer.index})`}>
              {layer.segments.map(segment => <path key={segment.key} d={segment.d} strokeWidth={line} />)}
            </g>
            {joints.map((point, position) => <circle key={position} cx={point.x} cy={point.y} r={ring} strokeWidth={line} />)}
          </g>
        );
      }) : null}

      {layers.map(layer => (
        <g key={layer.index} transform={layer.transform} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {layer.segments.filter(segment => selection.has(segment.key)).map(segment => (
            <path key={segment.key} d={segment.d} stroke={ACCENT} strokeOpacity={0.9}
              strokeWidth={Math.max(layer.strokeWidth * 0.35, 2 * unit)} />
          ))}
        </g>
      ))}

      {guides && analysis ? (
        <g fill="none" pointerEvents="none">
          {rootSegments.filter(segment => segment.kind === "curve").map(segment => (
            <g key={segment.key} stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke">
              {segment.controls.length === 2 ? <>
                <line x1={segment.start.x} y1={segment.start.y} x2={segment.controls[0]!.x} y2={segment.controls[0]!.y} vectorEffect="non-scaling-stroke" />
                <line x1={segment.end.x} y1={segment.end.y} x2={segment.controls[1]!.x} y2={segment.controls[1]!.y} vectorEffect="non-scaling-stroke" />
              </> : segment.controls[0] ? <polyline vectorEffect="non-scaling-stroke"
                points={[segment.start, segment.controls[0], segment.end].map(point => `${point.x},${point.y}`).join(" ")} /> : null}
            </g>
          ))}
          {analysis.arcs.map(arc => (
            <g key={arc.key} strokeWidth={1} vectorEffect="non-scaling-stroke">
              <circle cx={arc.center.x} cy={arc.center.y} r={arc.r} stroke={arc.radiusOffGrid ? DANGER : "currentColor"}
                strokeOpacity={arc.radiusOffGrid ? 0.8 : 0.25} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
              {arc.ends ? <polyline points={[arc.ends[0], arc.center, arc.ends[1]].map(point => `${point.x},${point.y}`).join(" ")}
                stroke="currentColor" strokeOpacity={0.3} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" /> : null}
              {arc.ends && arc.tangent ? <polyline points={[arc.ends[0], arc.tangent, arc.ends[1]].map(point => `${point.x},${point.y}`).join(" ")}
                stroke="currentColor" strokeOpacity={0.25} vectorEffect="non-scaling-stroke" /> : null}
              <circle cx={arc.center.x} cy={arc.center.y} r={3.5 * unit} stroke={arc.centerOffGrid ? DANGER : "currentColor"}
                strokeOpacity={0.8} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {analysis.angles.map(angle => (
            <text key={angle.key} x={angle.at.x} y={angle.at.y} dy={-6 * unit} fontSize={10 * unit} textAnchor="middle"
              fill="currentColor" fillOpacity={0.75} stroke="none" className="font-mono select-none">{angle.label}</text>
          ))}
          {analysis.snaps.map((snap, index) => (
            <g key={index}>
              <circle cx={snap.at.x} cy={snap.at.y} r={SNAP_MARKER_UNITS} fill={DANGER} fillOpacity={0.5} stroke={DANGER} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              {snap.suggestion ? <circle cx={snap.suggestion.x} cy={snap.suggestion.y} r={SNAP_MARKER_UNITS} fill={SUGGESTION} fillOpacity={0.5}
                stroke={SUGGESTION} strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null}
            </g>
          ))}
        </g>
      ) : null}

      {interactive ? stacked.map(layer => (
        <g key={layer.index} transform={layer.transform} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {layer.segments.map(segment => (
            <g key={segment.key} className="group/segment">
              <path d={segment.d} stroke="#000" strokeOpacity={0.5} strokeWidth={layer.strokeWidth} pointerEvents="none"
                className="opacity-0 group-hover/segment:opacity-100" />
              <path d={segment.d} stroke="transparent" strokeWidth={HIT_PIXELS} vectorEffect="non-scaling-stroke"
                pointerEvents="stroke" className="cursor-pointer" data-svg-segment={segment.key}
                onDoubleClick={() => onSegmentDoubleClick(segment.key)}
                onPointerDown={event => onSegmentPointerDown(segment.key, event)} />
            </g>
          ))}
        </g>
      )) : null}

      {handles.flatMap(handle => handle.links.map((link, index) => (
        <line key={`${handle.key}:link:${index}`} x1={link.x} y1={link.y} x2={handle.point.x} y2={handle.point.y}
          stroke={ACCENT} strokeOpacity={0.7} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )))}
      {handles.map(handle => (
        <g key={handle.key} className="pointer-events-auto cursor-grab active:cursor-grabbing"
          onPointerDown={event => onHandlePointerDown(handle, event)}>
          <circle cx={handle.point.x} cy={handle.point.y} r={(HANDLE_PIXELS + 1) * unit} fill="transparent" stroke="#fff"
            strokeWidth={4} vectorEffect="non-scaling-stroke" strokeOpacity={0.85} />
          <circle cx={handle.point.x} cy={handle.point.y} r={(HANDLE_PIXELS + 1) * unit} fill="transparent" stroke={ACCENT}
            strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={handle.kind === "radius" ? "3 2" : undefined}
            strokeOpacity={handle.kind === "control" ? 0.7 : 1} />
        </g>
      ))}

      {marquee ? <rect x={Math.min(marquee.from.x, marquee.to.x)} y={Math.min(marquee.from.y, marquee.to.y)}
        width={Math.abs(marquee.to.x - marquee.from.x)} height={Math.abs(marquee.to.y - marquee.from.y)}
        fill={ACCENT} fillOpacity={0.08} stroke={ACCENT} strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
      {draft}
    </>
  );
}
