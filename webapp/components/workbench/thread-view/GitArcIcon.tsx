/*
 * Exports:
 * - default GitArcIcon: render the matching square action glyph for one Git arc command. Keywords: git, arc, icon, plan, start, continue, add, remove, compare, restore.
 * - GitArcClaimIcon: render the flag marker used by claimed-file rows. Keywords: git, arc, icon, claim, file.
 * - GitArcPlannedClaimIcon: render the dashed flag marker used by planned-file rows. Keywords: git, arc, icon, plan, claim, file.
 */
import type { ReactNode } from "react";

import type { GitArcAction } from "../../../lib/workbench/git/git-arc-receipts";

function SvgFrame({ children, className = "size-4" }: { children: ReactNode; className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

export function GitArcClaimIcon({ className = "size-5" }: { className?: string }) {
  return (
    <SvgFrame className={className}>
      <path d="M6 22V2.8a.8.8 0 0 1 1.17-.71l11.38 5.69a.8.8 0 0 1 0 1.44L6 15.5" />
    </SvgFrame>
  );
}

export function GitArcPlannedClaimIcon({ className = "size-5" }: { className?: string }) {
  return (
    <SvgFrame className={className}>
      <path d="M6 6V3l2.7 1.3" />
      <path d="m11.15 5.48 2.7 1.3" />
      <path d="m16.3 7.95 2.7 1.3-2.7 1.3" />
      <path d="m13.85 11.73-2.7 1.3" />
      <path d="m8.7 14.2-2.7 1.3v-3" />
      <path d="M6 9.78V8.72" />
      <path d="M6 22v-3.75" />
    </SvgFrame>
  );
}

export default function GitArcIcon({ action, className = "size-4" }: { action: GitArcAction; className?: string }) {
  if (action === "plan") {
    return (
      <SvgFrame className={className}>
        <path d="M14 21h1" /><path d="M14 3h1" /><path d="M19 3a2 2 0 0 1 2 2" /><path d="M21 14v1" /><path d="M21 19a2 2 0 0 1-2 2" /><path d="M21 9v1" /><path d="M3 14v1" /><path d="M3 9v1" /><path d="M5 21a2 2 0 0 1-2-2" /><path d="M5 3a2 2 0 0 0-2 2" /><path d="M7 12h10" /><path d="M7 16h6" /><path d="M7 8h8" /><path d="M9 21h1" /><path d="M9 3h1" />
      </SvgFrame>
    );
  }
  if (action === "start" || action === "continue") {
    return (
      <SvgFrame className={className}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" />
      </SvgFrame>
    );
  }
  if (action === "add" || action === "adopt" || action === "remove") {
    return (
      <SvgFrame className={className}>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M8 12h8" />
        {action === "add" || action === "adopt" ? <path d="M12 8v8" /> : null}
      </SvgFrame>
    );
  }
  if (action === "mv") {
    return (
      <SvgFrame className={className}>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M8 12h8" />
        <path d="m12 16 4-4-4-4" />
      </SvgFrame>
    );
  }
  if (action === "propose") {
    return (
      <SvgFrame className={className}>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M7 8h8" /><path d="M7 12h10" /><path d="M7 16h6" />
      </SvgFrame>
    );
  }
  if (action === "compare" || action === "diff") {
    return (
      <SvgFrame className={className}>
        <path d="M16 12v2a2 2 0 0 1-2 2H9a1 1 0 0 0-1 1v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h0" />
        <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1h-5a2 2 0 0 0-2 2v2" />
      </SvgFrame>
    );
  }
  return (
    <SvgFrame className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <g transform="translate(4.5 4.5) scale(.625)">
        <path d="M9 14 4 9l5-5" vectorEffect="non-scaling-stroke" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" vectorEffect="non-scaling-stroke" />
      </g>
    </SvgFrame>
  );
}
