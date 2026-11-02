/*
 * Exports:
 * - default ThreadModeDivider: the left-aligned line a workflow mode switch draws across the thread: the mode's declared icon
 *   and name, a retitle beside it, opening onto the proofs filed on the way in. Tags, mode_set and thread_state all draw it.
 */
import { useContext, type ReactNode } from "react";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { findWorkflowMode, type ModeIcon } from "workbench-shared/workbench/thread/workflow-modes";
import { formatThreadStateChangeMode } from "../../../workbench/markdown/markdown-parse";
import { CircleDotIcon, ClipboardListIcon, FlagIcon, SearchIcon, SquarePenIcon } from "../workbench-icons";
import { ThreadProofOfWorkList, useThreadProofOfWork } from "./ThreadProofOfWorkItem";
import { ThreadWorkflowModeCatalogueContext } from "./use-workflow-mode-catalogue";

const MODE_ICONS: Record<ModeIcon, typeof FlagIcon> = {
  clipboard: ClipboardListIcon,
  flag: FlagIcon,
  pen: SquarePenIcon,
  search: SearchIcon,
};

function ModeLine({ mode, title }: { mode: string; title?: string | null }) {
  const declared = findWorkflowMode(useContext(ThreadWorkflowModeCatalogueContext), mode);
  const Icon = declared?.icon ? MODE_ICONS[declared.icon] : CircleDotIcon;
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[0.84em]">
      <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-text" data-thread-state-change-label="true">
        <span className="text-fg/muted"><Icon size={14} /></span>
        {formatThreadStateChangeMode(mode)}
      </span>
      {title ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-fg/muted">
          <span>·</span><FlagIcon size={14} /><span className="truncate">{title}</span>
        </span>
      ) : null}
    </span>
  );
}

export default function ThreadModeDivider({ actions, mode, proofs = [], title }: {
  /** Controls a markdown section offers beside its mode line. */
  actions?: ReactNode;
  mode: string;
  /** Filing calls whose proofs the line opens onto. */
  proofs?: readonly Extract<ThreadItem, { type: "mcpToolCall" }>[];
  title?: string | null;
}) {
  const rule = "flex items-center gap-2 leading-none after:(block h-px flex-1 bg-[color-mix(in srgb, var(--text) 10%, transparent)] content-[''])";
  const line = <><ModeLine mode={mode} title={title} />{actions}</>;
  const proof = useThreadProofOfWork(proofs);
  return (
    <div className="relative my-[0.85em] font-sans last:mb-0" data-thread-state-change="true" data-thread-state-mode={mode}>
      {proof.families.length ? (
        <details>
          <summary className={`cursor-pointer list-none ${rule}`}>{line}</summary>
          <div className="py-2 pl-6 text-[0.92em]"><ThreadProofOfWorkList proof={proof} /></div>
        </details>
      ) : <div className={rule}>{line}</div>}
    </div>
  );
}
