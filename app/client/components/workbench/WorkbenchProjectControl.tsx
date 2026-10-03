/*
 * Exports:
 * - default WorkbenchProjectControl: draft project pill beside the harness control; click rotates to the next selected project, press-drag picks one.
 */
"use client";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import ChevronIcon from "./ChevronIcon";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";

type DraftProject = WorkbenchProjectOption | WorkbenchLogicalProject;

function projectLabel(project: DraftProject) {
  return "matchKey" in project ? project.displayName ?? project.label : project.name || project.id;
}

export default function WorkbenchProjectControl({
  disabled = false,
  onSelect,
  project,
  projects,
}: {
  disabled?: boolean;
  onSelect: (projectId: string) => void;
  project: DraftProject;
  projects: readonly DraftProject[];
}) {
  const label = projectLabel(project);
  return (
    <WorkbenchPressDragMenu
      label={`Create thread in ${label}. Click for the next selected project, or drag to choose one.`}
      disabled={disabled}
      triggerAppearance="plain"
      triggerClassName="min-w-28! max-w-48 shrink-0 justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 font-semibold text-text hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] disabled:cursor-wait disabled:opacity-60"
      items={projects.map(candidate => ({
        id: candidate.id,
        checked: candidate.id === project.id,
        content: <span className="flex min-w-0 items-center gap-2">
          <WorkbenchProjectIcon project={candidate} variant="thread" />
          <span className="truncate">{projectLabel(candidate)}</span>
        </span>,
      }))}
      onActivate={() => {
        const index = projects.findIndex(candidate => candidate.id === project.id);
        const next = projects[(index < 0 ? 0 : index + 1) % projects.length];
        if (next) onSelect(next.id);
      }}
      onSelect={onSelect}
    >
      <WorkbenchProjectIcon project={project} variant="thread" />
      <span className="truncate">{label}</span>
      <ChevronIcon aria-hidden="true" className="shrink-0" size={14} />
    </WorkbenchPressDragMenu>
  );
}
