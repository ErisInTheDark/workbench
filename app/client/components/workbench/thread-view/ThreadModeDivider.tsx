/*
 * Exports:
 * - default ThreadModeDivider: the heading a workflow mode switch opens across the thread: a hairline and glow
 *   fading down behind what follows and out at both edges, in the mode's declared colour, with its declared icon and name, a retitle and any
 *   always-editable grant beside it, opening onto the proofs filed on the way in. Tags, mode_set and thread_state all draw it.
 */
import { useContext, type CSSProperties, type ReactNode } from "react";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { findWorkflowMode, type ModeIcon } from "workbench-shared/workbench/thread/workflow-modes";
import { formatThreadStateChangeMode } from "../../../workbench/markdown/markdown-parse";
import { resolveThreadTextColor } from "../../../workbench/markdown/thread-emphasis-markup";
import { CircleDotIcon, ClipboardListIcon, FlagIcon, SearchIcon, SquarePenIcon } from "../workbench-icons";
import { getThreadTextColorStyle } from "./thread-markdown-emphasis-colors";
import { ThreadProofOfWorkList, useThreadProofOfWork } from "./ThreadProofOfWorkItem";
import { ThreadWorkflowModeCatalogueContext } from "./use-workflow-mode-catalogue";

const MODE_ICONS: Record<ModeIcon, typeof FlagIcon> = {
  clipboard: ClipboardListIcon,
  flag: FlagIcon,
  pen: SquarePenIcon,
  search: SearchIcon,
};

function readModeColor(color: string | null | undefined): { className: string; style?: CSSProperties } {
  const resolved = color ? resolveThreadTextColor(color) : null;
  if (!resolved) return { className: "text-fg/muted" };
  const paint = getThreadTextColorStyle(resolved);
  return { className: paint.className ?? "", style: paint.style };
}

export default function ThreadModeDivider({ actions, editable = null, mode, proofs = [], title }: {
  /** Controls a markdown section offers beside its mode line. */
  actions?: ReactNode;
  /** Always-editable paths the switch set; empty when it cleared them. */
  editable?: readonly string[] | null;
  mode: string;
  /** Filing calls whose proofs the line opens onto. */
  proofs?: readonly Extract<ThreadItem, { type: "mcpToolCall" }>[];
  title?: string | null;
}) {
  const declared = findWorkflowMode(useContext(ThreadWorkflowModeCatalogueContext), mode);
  const Icon = declared?.icon ? MODE_ICONS[declared.icon] : CircleDotIcon;
  const color = readModeColor(declared?.color);
  const proof = useThreadProofOfWork(proofs);
  const line = (
    <span className="flex items-center gap-2 leading-none">
      <span className={`inline-flex min-w-0 items-center gap-2 text-[0.84em] ${color.className}`} style={color.style}>
        <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold" data-thread-state-change-label="true">
          <Icon size={14} />
          {formatThreadStateChangeMode(mode)}
        </span>
        {title ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 opacity-70">
            <span>·</span><FlagIcon size={14} /><span className="truncate">{title}</span>
          </span>
        ) : null}
        {editable ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 opacity-70" data-thread-state-change-editable="true">
            <span>·</span><SquarePenIcon size={14} />
            <span className="truncate">{editable.length ? `always editable: ${editable.join(", ")}` : "always editable cleared"}</span>
          </span>
        ) : null}
      </span>
      {actions}
    </span>
  );
  return (
    <div className="-mx-5 my-[0.85em] font-sans last:mb-0 md:-mx-16" data-thread-state-change="true" data-thread-state-mode={mode}>
      {/* Zero net height: the heading sits on it and whatever follows paints over it. Reaches past the text into the gutter and fades out before its edges, edge to edge on narrow screens. */}
      <div
        aria-hidden="true"
        className={`
          pointer-events-none -mb-36 h-36 border-t border-current
          [background-image:linear-gradient(to_bottom,color-mix(in_srgb,currentColor_18%,transparent),color-mix(in_srgb,currentColor_7%,transparent)_2.2rem,transparent)]
          [mask-image:linear-gradient(to_right,transparent,#000_2.5rem,#000_calc(100%-2.5rem),transparent)]
          md:[mask-image:linear-gradient(to_right,transparent,#000_9rem,#000_calc(100%-9rem),transparent)]
          ${color.className}
        `}
        style={color.style}
      />
      <div className="px-5 pb-3 pt-[0.7rem] md:px-16">
        {proof.families.length ? (
          <details>
            <summary className="cursor-pointer list-none">{line}</summary>
            <div className="py-2 pl-6 text-[0.92em]"><ThreadProofOfWorkList proof={proof} /></div>
          </details>
        ) : line}
      </div>
    </div>
  );
}
