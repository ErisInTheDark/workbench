/* Exports: default WorkbenchTag: shared muted pill for compact metadata. */
import type { ReactNode } from "react";

export default function WorkbenchTag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-fg/6 px-2 py-0.5 text-xs font-medium text-fg/muted">{children}</span>;
}
