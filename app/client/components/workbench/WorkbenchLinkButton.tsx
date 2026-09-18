/*
 * Default export:
 * - WorkbenchLinkButton: semantic link with a labelled action target and theme-aware hover treatment.
 */
import type { ComponentPropsWithRef } from "react";

export default function WorkbenchLinkButton({ className = "", ...props }: ComponentPropsWithRef<"a">) {
  return <a {...props} className={`
    inline-flex min-h-9 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-text
    transition-colors hover:bg-accent-soft/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
    ${className}
  `} />;
}
