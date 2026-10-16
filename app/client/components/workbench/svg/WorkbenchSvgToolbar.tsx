/*
 * Exports:
 * - SvgViewOptions: canvas display choices owned by the editor view.
 * - SvgSnapChoice: snap step choices.
 * - default WorkbenchSvgToolbar: one row of drawing tools and shape transforms, then canvas size, overlay toggles, snapping and
 *   the caller's file actions.
 */
"use client";

import { useState, type ReactNode } from "react";
import IconButton from "../../ui/IconButton";
import PressDragMenu from "../../ui/PressDragMenu";
import RadioRow from "../../ui/RadioRow";
import {
  CircleDotIcon, CircleIcon, FlipHorizontalIcon, FlipVerticalIcon, Grid3x3Icon, MagnetIcon, MagnetOffIcon, MousePointerIcon,
  PaletteIcon, PenToolIcon, RulerIcon, SlashIcon, SquareIcon,
} from "../workbench-icons";
import type { SvgCanvasTool } from "./WorkbenchSvgCanvas";

export type SvgSnapChoice = "off" | "1" | "0.5" | "0.25";

export interface SvgViewOptions {
  colors: boolean;
  grid: boolean;
  guides: boolean;
  snap: SvgSnapChoice;
}

const TOOLS: Array<{ tool: SvgCanvasTool; label: string; icon: ReactNode }> = [
  { tool: "select", label: "Select (V)", icon: <MousePointerIcon size={16} /> },
  { tool: "pen", label: "Pen (P): click for corners, drag for curves, Enter finishes, click the start to close", icon: <PenToolIcon size={16} /> },
  { tool: "line", label: "Line (L)", icon: <SlashIcon size={16} /> },
  { tool: "rect", label: "Rectangle (R)", icon: <SquareIcon size={16} /> },
  { tool: "circle", label: "Circle (C)", icon: <CircleIcon size={16} /> },
];

const SNAP_LABELS: Record<SvgSnapChoice, string> = { off: "Off", "1": "1", "0.5": "1/2", "0.25": "1/4" };
const SNAP_ORDER: SvgSnapChoice[] = ["1", "0.5", "0.25", "off"];

function SnapLabel({ snap }: { snap: SvgSnapChoice }) {
  return (
    <span className="inline-flex items-center gap-1 text-[0.78rem] font-medium">
      {snap === "off" ? <MagnetOffIcon size={16} /> : <MagnetIcon size={16} />}
      {snap === "off" ? null : <span className="font-mono">{SNAP_LABELS[snap]}</span>}
    </span>
  );
}

function CanvasSizeControl({ size, onResize }: {
  size: { width: number; height: number };
  onResize: (width: number, height: number, scaleContent: boolean) => void;
}) {
  const [draft, setDraft] = useState<{ width: string; height: string } | null>(null);
  const format = (value: number) => String(Math.round(value * 1000) / 1000);
  if (!draft) {
    return <button type="button" title="Canvas size" className="rounded-lg px-2 py-1 font-mono text-[0.78rem] text-fg/muted hover:bg-fg/5 hover:text-text"
      onClick={() => setDraft({ width: format(size.width), height: format(size.height) })}>
      {format(size.width)}x{format(size.height)}
    </button>;
  }
  const width = Number(draft.width);
  const height = Number(draft.height);
  const valid = width > 0 && height > 0;
  const input = (key: "width" | "height") => (
    <input aria-label={`Canvas ${key}`} inputMode="decimal" value={draft[key]}
      className="w-12 rounded-md bg-fg/5 px-1.5 py-0.5 text-center font-mono text-[0.78rem] text-text outline-none focus:bg-fg/8"
      onChange={event => setDraft({ ...draft, [key]: event.target.value })}
      onKeyDown={event => { if (event.key === "Escape") setDraft(null); }} />
  );
  const apply = (scaleContent: boolean) => {
    if (!valid) return;
    onResize(width, scaleContent ? size.height * width / size.width : height, scaleContent);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-1 text-[0.78rem]" role="group" aria-label="Canvas size">
      {input("width")}<span className="text-fg/muted">x</span>{input("height")}
      <button type="button" disabled={!valid} title="Change the canvas, keeping shapes where they are"
        className="rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-soft disabled:opacity-50" onClick={() => apply(false)}>Resize</button>
      <button type="button" disabled={!valid} title="Scale shapes with the canvas (keeps the aspect ratio of the width)"
        className="rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-soft disabled:opacity-50" onClick={() => apply(true)}>Scale</button>
      <button type="button" className="rounded-md px-1.5 py-0.5 text-fg/muted hover:bg-fg/5" onClick={() => setDraft(null)}>Cancel</button>
    </div>
  );
}

export default function WorkbenchSvgToolbar({
  canCirclify,
  canvasSize,
  fileActions,
  onCirclify,
  onFlip,
  onOptionsChange,
  onResize,
  onToolChange,
  options,
  tool,
}: {
  canCirclify: boolean;
  canvasSize: { width: number; height: number } | null;
  fileActions: ReactNode;
  onCirclify: () => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
  onOptionsChange: (options: SvgViewOptions) => void;
  onResize: (width: number, height: number, scaleContent: boolean) => void;
  onToolChange: (tool: SvgCanvasTool) => void;
  options: SvgViewOptions;
  tool: SvgCanvasTool;
}) {
  const toggle = (key: "colors" | "grid" | "guides", label: string, icon: ReactNode) => (
    <IconButton label={options[key] ? `Hide ${label}` : `Show ${label}`} size="small" display="hover-border" aria-pressed={options[key]}
      onClick={() => onOptionsChange({ ...options, [key]: !options[key] })}>{icon}</IconButton>
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 py-2">
      <RadioRow<SvgCanvasTool> ariaLabel="Canvas tool" value={tool} onChange={onToolChange}
        options={TOOLS.map(item => ({ value: item.tool, label: item.icon, ariaLabel: item.label, title: item.label }))} />
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-fg/10" />
      <IconButton label="Flip horizontally" title="Flip horizontally (selection, or everything)" size="small" display="hover-border"
        onClick={() => onFlip("horizontal")}><FlipHorizontalIcon size={16} /></IconButton>
      <IconButton label="Flip vertically" title="Flip vertically (selection, or everything)" size="small" display="hover-border"
        onClick={() => onFlip("vertical")}><FlipVerticalIcon size={16} /></IconButton>
      <IconButton label="Circlify" title="Replace selected circular arcs with circles" size="small" display="hover-border"
        disabled={!canCirclify} onClick={onCirclify}><CircleDotIcon size={16} /></IconButton>
      <div className="ml-auto flex items-center gap-1">
        {canvasSize ? <CanvasSizeControl size={canvasSize} onResize={onResize} /> : null}
        {toggle("colors", "segment colours", <PaletteIcon size={16} />)}
        {toggle("guides", "guides and violations", <RulerIcon size={16} />)}
        {toggle("grid", "grid", <Grid3x3Icon size={16} />)}
        <PressDragMenu
          label={options.snap === "off" ? "Snapping off" : `Snap to ${SNAP_LABELS[options.snap]} unit`}
          heading="Snap points to"
          triggerAppearance="plain"
          triggerClassName="inline-flex h-8 items-center rounded-full px-2 text-fg/muted hover:bg-fg/5 hover:text-text"
          align="end"
          items={SNAP_ORDER.map(id => ({ id, checked: id === options.snap,
            content: <span className="inline-flex items-center gap-2"><SnapLabel snap={id} />{id === "off" ? "No snapping" : `${SNAP_LABELS[id]} unit`}</span> }))}
          onSelect={id => {
            const snap = SNAP_ORDER.find(candidate => candidate === id);
            if (snap) onOptionsChange({ ...options, snap });
          }}
        >
          <SnapLabel snap={options.snap} />
        </PressDragMenu>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-fg/10" />
        {fileActions}
      </div>
    </div>
  );
}
