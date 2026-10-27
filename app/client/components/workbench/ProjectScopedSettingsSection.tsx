/*
 * Exports:
 * - ProjectScopedSettingsProject: one project a settings section can give its own settings: id, label and icon facts.
 * - default ProjectScopedSettingsSection: a settings section with defaults for every project plus per-project settings; its
 *   header menu adds a project, and once any project has its own, every scope shows as a disclosure (defaults first).
 */
"use client";

import { useState, type ReactNode } from "react";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import Disclosure from "../ui/Disclosure";
import PressDragMenu from "../ui/PressDragMenu";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
import { PlusIcon } from "./workbench-icons";

export interface ProjectScopedSettingsProject<Id extends string> {
  id: Id;
  label: string;
  iconProject: WorkbenchLogicalProject;
}

function ProjectLabel({ project }: { project: ProjectScopedSettingsProject<string> }) {
  return <span className="flex min-w-0 items-center gap-2">
    <WorkbenchProjectIcon project={project.iconProject} variant="thread" />
    <span className="truncate">{project.label}</span>
  </span>;
}

export default function ProjectScopedSettingsSection<Id extends string>({
  id, title, addLabel, defaultLabel, projects, scopedProjectIds, renderScope,
}: {
  id: string;
  title: string;
  /** Header menu label, such as "Add project-specific overrides". */
  addLabel: string;
  /** Disclosure label of the settings every project gets, such as "Default options". */
  defaultLabel: string;
  /** Projects that can be given their own settings here. */
  projects: readonly ProjectScopedSettingsProject<Id>[];
  /** Projects that already have their own settings; picking another from the menu shows it until the view closes. */
  scopedProjectIds: readonly Id[];
  /** The settings for one project, or for every project when null. */
  renderScope: (projectId: Id | null) => ReactNode;
}) {
  const [added, setAdded] = useState<ReadonlySet<Id>>(() => new Set());
  const scoped = projects.filter(project => added.has(project.id) || scopedProjectIds.includes(project.id));
  const available = projects.filter(project => !scoped.includes(project));
  return <section id={id} className="scroll-mt-24 space-y-1">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-1 pt-6">
      <h2 className="m-0 text-base font-semibold text-text">{title}</h2>
      {available.length ? <PressDragMenu
        label={addLabel}
        align="end"
        triggerClassName="text-sm text-fg/muted"
        items={available.map(project => ({ id: project.id, checked: false, content: <ProjectLabel project={project} /> }))}
        onSelect={projectId => setAdded(current => new Set(current).add(projectId as Id))}
      ><PlusIcon size={16} className="shrink-0" /><span>{addLabel}</span></PressDragMenu> : null}
    </div>
    {scoped.length ? <div className="space-y-2">
      <Disclosure summary={defaultLabel} summaryClassName="py-2 text-sm" contentClassName="pl-6">
        {renderScope(null)}
      </Disclosure>
      {scoped.map(project => <Disclosure key={project.id} defaultOpen summaryClassName="py-2 text-sm text-text"
        contentClassName="pl-6" summary={<ProjectLabel project={project} />}>
        {renderScope(project.id)}
      </Disclosure>)}
    </div> : renderScope(null)}
  </section>;
}
