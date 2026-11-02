/*
 * Exports:
 * - default ThreadModeDivider: the heading a workflow mode switch opens across the thread: a top border, rail and wash
 *   fading down behind what follows, in the mode's declared colour, with its declared icon and name, a retitle beside it,
 *   opening onto the proofs filed on the way in. Tags, mode_set and thread_state all draw it.
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

export default function ThreadModeDivider({ actions, mode, proofs = [], title }: {
  /** Controls a markdown section offers beside its mode line. */
  actions?: ReactNode;
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
      </span>
      {actions}
    </span>
  );
  return (
    <div className="my-[0.85em] font-sans last:mb-0" data-thread-state-change="true" data-thread-state-mode={mode}>
      {/* Zero net height: the heading sits on it and whatever follows paints over it. */}
      <div
        aria-hidden="true"
        className={`
          pointer-events-none -mb-36 h-36 border-t-[0.22rem] border-current bg-no-repeat
          [background-image:linear-gradient(to_bottom,currentColor,transparent),linear-gradient(to_bottom,color-mix(in_srgb,currentColor_10%,transparent),transparent)]
          [background-size:1px_100%,100%_100%]
          ${color.className}
        `}
        style={color.style}
      />
      <div className="pl-[0.95rem] pt-[0.7rem]">
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
