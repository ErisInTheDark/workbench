/*
 * Exports:
 * - default WorkbenchGitSplitPane: a resizable file column beside a scrolling detail column; on phones it shows one at a
 *   time, the detail once `showDetail` is set, with a back control.
 */
"use client";
import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import TooltipIconButton from "../../ui/TooltipIconButton";
import { BackArrowIcon } from "../workbench-icons";

const MIN = 180;
const MAX = 600;
/** One file-column width for every git tab, so switching tabs never jumps the layout. */
let rememberedWidth = 300;

export default function WorkbenchGitSplitPane({ files, children, showDetail, onShowFiles, viewport }: {
  files: ReactNode;
  children: ReactNode;
  showDetail: boolean;
  onShowFiles(): void;
  viewport?: RefObject<HTMLDivElement | null>;
}) {
  const [width, setWidth] = useState(rememberedWidth);
  const split = useRef<HTMLDivElement>(null);
  const resize = (next: number) => {
    const bounds = split.current?.getBoundingClientRect();
    const clamped = Math.max(MIN, Math.min(MAX, bounds ? bounds.width - 240 : MAX, next));
    rememberedWidth = clamped;
    setWidth(clamped);
  };
  return <div ref={split} className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[var(--git-file-width)_0.5rem_minmax(0,1fr)]"
    style={{ "--git-file-width": `${width}px` } as CSSProperties}>
    <aside aria-label="Files" className={`
      min-h-0 min-w-0 flex-col pb-3 md:flex
      ${showDetail ? "hidden" : "flex"}
    `}>{files}</aside>
    <div role="separator" aria-label="Resize files" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={MIN} aria-valuemax={MAX}
      tabIndex={0} className="group hidden cursor-col-resize touch-none justify-center outline-none md:flex"
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        resize(width + (event.key === "ArrowRight" ? 20 : -20));
      }}
      onPointerDown={event => {
        if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }
      }}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = split.current?.getBoundingClientRect();
        if (bounds) resize(event.clientX - bounds.left);
      }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onDoubleClick={() => resize(300)}>
      <span className="my-2 w-0.5 rounded-full transition-colors group-hover:bg-accent-soft group-focus-visible:bg-accent" />
    </div>
    <div ref={viewport} className={`
      scrollbar-hover-reveal min-h-0 min-w-0 overflow-y-auto px-2 pb-3 md:block
      ${showDetail ? "block" : "hidden"}
    `}>
      <div className="pb-1 md:hidden">
        <TooltipIconButton size="small" label="Files" onClick={onShowFiles}><BackArrowIcon size={16} /></TooltipIconButton>
      </div>
      {children}
    </div>
  </div>;
}
