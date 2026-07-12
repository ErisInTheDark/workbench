/*
 * Exports:
 * - default ThreadHarnessControl: render a mutable harness rotator or immutable harness identity. Keywords: thread, composer, harness, control.
 * - formatHarnessLabel: format Workbench harness identifiers for composer UI. Keywords: harness, label.
 */
"use client";

import type { WorkbenchHarness } from "../../../lib/types";
import { HarnessIcon } from "../workbench-icons";

export function formatHarnessLabel(harness: WorkbenchHarness) {
  return harness === "codex" ? "Codex" : harness === "copilot" ? "Copilot" : "OpenCode";
}

export default function ThreadHarnessControl({ canToggle = false, harness, onToggle }: {
  canToggle?: boolean;
  harness: WorkbenchHarness;
  onToggle?: () => void;
}) {
  const content = <><HarnessIcon className="size-4" harness={harness} /><span>{formatHarnessLabel(harness)}</span></>;
  return canToggle ? (
    <button type="button" className="inline-flex min-w-28 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 font-semibold text-text transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft" onClick={onToggle}>{content}</button>
  ) : <span className="inline-flex items-center gap-2 font-semibold text-text">{content}</span>;
}
