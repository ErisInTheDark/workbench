/*
 * Exports:
 * - default ErrorCard: tinted danger card with an alert icon for a failure the user should read.
 */
import type { ReactNode } from "react";
import { CircleAlertIcon } from "../workbench/workbench-icons";

export default function ErrorCard({ label, className = "", children }: { label?: string; className?: string; children: ReactNode }) {
  return <section aria-label={label} role="alert" className={`
    grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-[0.7rem]
    bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] px-3.5 py-3 text-danger
    ${className}
  `}>
    <CircleAlertIcon className="mt-[0.1em] shrink-0" size={16} />
    <p className="m-0 min-w-0 whitespace-pre-wrap text-[0.86em] leading-[1.55]">{children}</p>
  </section>;
}
