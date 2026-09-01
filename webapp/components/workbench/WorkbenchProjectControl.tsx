/*
 * Exports:
 * - default WorkbenchProjectControl: render the home draft's click-to-next project rotator beside the harness control. Keywords: thread, composer, project, rotator.
 */
"use client";

import type { WorkbenchProjectOption } from "../../lib/types";
import { ProjectIcon } from "./workbench-icons";

export default function WorkbenchProjectControl({
  disabled = false,
  onRotate,
  project,
}: {
  disabled?: boolean;
  onRotate: () => void;
  project: WorkbenchProjectOption;
}) {
  const label = project.name || project.id;
  return (
    <button
      aria-label={`Create thread in ${label}. Click to use the next recent project.`}
      className="inline-flex min-w-28 max-w-48 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 font-semibold text-text transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-wait disabled:opacity-60"
      disabled={disabled}
      onClick={onRotate}
      title={label}
      type="button"
    >
      <ProjectIcon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
