/*
 * Exports:
 * - default ThreadModeDivider: the "Mode" rule a workflow mode switch draws across the thread, from a tag or a mode_set call.
 */
import type { ReactNode } from "react";
import { formatThreadStateChangeMode } from "../../../workbench/markdown/markdown-parse";

export default function ThreadModeDivider({ actions, mode }: { actions?: ReactNode; mode: string }) {
  return (
    <div
      className={`
        relative my-[0.85em] flex items-center gap-2 font-sans leading-none text-fg/muted last:mb-0
        before:(block h-px flex-1 bg-[color-mix(in srgb, var(--text) 10%, transparent)] content-[''])
        after:(block h-px flex-1 bg-[color-mix(in srgb, var(--text) 10%, transparent)] content-[''])
      `}
      data-thread-state-change="true"
      data-thread-state-mode={mode}
    >
      <span className="text-[0.62em] font-medium uppercase tracking-[0.14em]" data-thread-state-change-kicker="true">Mode</span>
      <span className="text-[0.84em] font-semibold text-text" data-thread-state-change-label="true">{formatThreadStateChangeMode(mode)}</span>
      {actions}
    </div>
  );
}
