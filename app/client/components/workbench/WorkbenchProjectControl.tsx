/*
 * Exports:
 * - default WorkbenchProjectControl: project pill choosing among selected projects; click rotates to the next one, press-drag picks one.
 */
"use client";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import ChevronIcon from "./ChevronIcon";
import PressDragMenu from "../ui/PressDragMenu";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";

type ControlProject = WorkbenchProjectOption | WorkbenchLogicalProject;

function projectLabel(project: ControlProject) {
  return "matchKey" in project ? project.displayName ?? project.label : project.name || project.id;
}

export default function WorkbenchProjectControl({
  action = "Create thread in",
  disabled = false,
  onSelect,
  project,
  projects,
}: {
  /** What choosing a project does, read before its name. */
  action?: string;
  disabled?: boolean;
  onSelect: (projectId: string) => void;
  project: ControlProject;
  projects: readonly ControlProject[];
}) {
  const label = projectLabel(project);
  return (
    <PressDragMenu
      label={`${action} ${label}. Click for the next selected project, or drag to choose one.`}
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
    </PressDragMenu>
  );
}
