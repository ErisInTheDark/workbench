/*
 * Exports:
 * - SettingsMenuItem: icon-led settings row menu entry, optionally styled as destructive.
 * - IconLabel: icon-led button label.
 */
import type { ReactNode } from "react";

export function SettingsMenuItem({ icon, danger = false, children }: { icon: ReactNode; danger?: boolean; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-2 ${danger ? "text-danger" : ""}`}>{icon}{children}</span>;
}

export function IconLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{icon}{children}</span>;
}
