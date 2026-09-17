/* Exports: default WorkbenchTag: shared muted pill for compact metadata. */
import type { ReactNode } from "react";

export default function WorkbenchTag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--tag-fg-bg:color-mix(in_srgb,var(--text)_6%,var(--fg-bg,var(--bg)))] px-2 py-0.5 text-xs font-medium [color:color-mix(in_srgb,var(--text)_var(--muted-strength),var(--tag-fg-bg))]">{children}</span>;
}
