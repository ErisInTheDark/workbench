/*
 * Exports:
 * - default SendActionBadge: shared corner treatment for send-action indicators, plain or in a warning tone.
 */
import type { ReactNode } from "react";

export default function SendActionBadge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warning" }) {
  return (
    <span
      aria-hidden="true"
      className={`
        absolute -right-2.5 -bottom-2.5 inline-flex size-3.5 items-center justify-center rounded-full
        ring-2 ring-[color:var(--app-bg-solid)]
        ${tone === "warning" ? "bg-amber-500 text-black" : "bg-[color:var(--text)] text-[color:var(--app-bg-solid)]"}
      `}
    >
      {children}
    </span>
  );
}
