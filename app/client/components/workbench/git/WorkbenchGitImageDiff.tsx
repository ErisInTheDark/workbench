/* Exports: default WorkbenchGitImageDiff: show inert before/after images with synchronised zoom and pan. */
"use client";
import { useRef, useState } from "react";
import { useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitImageDiff() {
  const snapshot = useWorkingTreeSnapshot();
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [background, setBackground] = useState<"theme" | "light" | "dark">("theme");
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const preview = snapshot.preview;
  const reset = () => { setZoom(null); setPan({ x: 0, y: 0 }); };
  if (!preview) return <p className="p-4 text-sm text-fg/muted">{snapshot.contentError ? "Image preview unavailable." : "Loading image preview..."}</p>;
  if (preview.unavailable) return <p className="p-4 text-sm text-fg/muted">{preview.unavailable}</p>;
  return <div className="space-y-3 p-3">
    <div className="flex items-center gap-2 text-xs">
      <button type="button" className="rounded px-2 py-1 hover:bg-accent-soft" onClick={reset}>Fit</button>
      <input aria-label="Image zoom" type="range" min={10} max={400} value={zoom ?? 100} onChange={event => setZoom(Number(event.target.value))} />
      <span>{zoom === null ? "Auto" : `${zoom}%`}</span>
      <select aria-label="Image background" value={background} className="ml-auto rounded bg-bg p-1" onChange={event => setBackground(event.target.value as typeof background)}>
        <option value="theme">Theme background</option><option value="light">Light background</option><option value="dark">Dark background</option>
      </select>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(["before", "after"] as const).map(side => <div key={side}>
        <p className="text-xs text-fg/muted">{side === "before" ? "Before" : "After"}</p>
        <div className={`
          relative flex h-80 touch-none items-center justify-center overflow-hidden rounded-lg bg-checkerboard
          ${background === "light" ? "bg-white text-black" : background === "dark" ? "bg-neutral-900 text-white" : "bg-bg"}
        `}
          onWheel={event => { setZoom(value => Math.max(10, Math.min(400, (value ?? 100) + (event.deltaY < 0 ? 10 : -10)))); }}
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
          {preview[side] === null ? <span className="text-sm text-fg/muted">No image</span> :
            <img src={`data:${preview.mime};base64,${preview[side]}`} alt={`${side} version`} draggable={false}
              className="max-h-full max-w-full select-none object-contain"
              style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${(zoom ?? 100) / 100})` }} />}
        </div>
      </div>)}
    </div>
  </div>;
}
