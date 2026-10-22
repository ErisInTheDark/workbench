/* Exports: default WorkbenchGitImageDiff: show inert before/after images with synchronised wheel zoom, drag pan and backdrop choice. */
"use client";
import { useRef, useState } from "react";
import RadioRow from "../../ui/RadioRow";
import TooltipIconButton from "../../ui/TooltipIconButton";
import { ZoomInIcon } from "../workbench-icons";
import { useGitChangeset } from "./WorkbenchGitChangesetProvider";

type Backdrop = "checker" | "light" | "dark";
const BACKDROPS: Record<Backdrop, string> = {
  checker: "bg-checkerboard",
  light: "bg-white",
  dark: "bg-neutral-900",
};
const swatch = (backdrop: Backdrop) => <span aria-hidden="true" className={`size-3 rounded-full ring-1 ring-fg/20 ${BACKDROPS[backdrop]}`} />;

export default function WorkbenchGitImageDiff() {
  const { snapshot } = useGitChangeset();
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const preview = snapshot.preview;
  const reset = () => { setZoom(null); setPan({ x: 0, y: 0 }); };
  if (!preview) return null;
  if (preview.unavailable) return <p className="py-4 text-sm text-fg/muted">{preview.unavailable}</p>;
  const sides = (["before", "after"] as const).filter(side => preview[side] !== null);
  return <div className="space-y-3 pb-4">
    <div className="flex items-center gap-2 text-xs text-fg/muted">
      <RadioRow ariaLabel="Image backdrop" value={backdrop} onChange={setBackdrop} options={[
        { value: "checker", label: swatch("checker"), ariaLabel: "Checkerboard backdrop", icon: null },
        { value: "light", label: swatch("light"), ariaLabel: "Light backdrop", icon: null },
        { value: "dark", label: swatch("dark"), ariaLabel: "Dark backdrop", icon: null },
      ]} />
      <span className="ml-auto tabular-nums">{zoom === null ? "" : `${zoom}%`}</span>
      {zoom !== null ? <TooltipIconButton size="small" label="Fit" onClick={reset}><ZoomInIcon size={16} /></TooltipIconButton> : null}
    </div>
    <div className={`grid grid-cols-1 gap-3 ${sides.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {sides.map(side => <div key={side} className={`
        relative flex h-80 touch-none items-center justify-center overflow-hidden rounded-2xl
        ${BACKDROPS[backdrop]}
        ${side === "before" && sides.length > 1 ? "opacity-80" : ""}
      `}
        onWheel={event => { setZoom(value => Math.max(10, Math.min(800, (value ?? 100) + (event.deltaY < 0 ? 10 : -10)))); }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (start) setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={reset}>
        <img src={`data:${preview.mime};base64,${preview[side]}`} alt={side === "before" ? "Before" : "After"} draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${(zoom ?? 100) / 100})` }} />
      </div>)}
    </div>
  </div>;
}
