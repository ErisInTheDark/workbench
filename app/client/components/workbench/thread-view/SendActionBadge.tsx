/*
 * Exports:
 * - default SendActionBadge: shared corner treatment for send-action indicators.
 */
import type { ReactNode } from "react";

export default function SendActionBadge({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="
        absolute -right-2.5 -bottom-2.5 inline-flex size-3.5 items-center justify-center rounded-full
        bg-[color:var(--text)] text-[color:var(--app-bg-solid)]
        ring-2 ring-[color:var(--app-bg-solid)]
      "
    >
      {children}
    </span>
  );
}
