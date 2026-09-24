/*
 * Exports:
 * - default WorkbenchProjectLocationMenu: choose one concrete folder for browsing or a new draft.
 */
"use client";

import type { WorkbenchLogicalProject } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";

export default function WorkbenchProjectLocationMenu({
  project, selected, onSelect, label,
}: {
  project: WorkbenchLogicalProject;
  selected: ProjectLocationReference | null;
  onSelect: (location: ProjectLocationReference) => void;
  label: string;
}) {
  const locations = project.locations;
  const current = locations.find(location =>
    location.target.daemonId === selected?.daemonId && location.target.projectId === selected?.projectId);
  return (
    <WorkbenchPressDragMenu
      label={label}
      items={locations.map((location, index) => ({
        id: String(index),
        checked: location === current,
        content: (
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate">{location.hostname}</span>
            <span className="truncate font-mono text-[0.72em] text-fg/muted">{location.rootPath}</span>
            {!location.project ? <span className="text-[0.72em] text-danger">Unavailable</span> : null}
          </span>
        ),
      }))}
      onSelect={id => {
        const location = locations[Number(id)];
        if (location) onSelect(location.target);
      }}
    >
      <span className="min-w-0 max-w-52 truncate">
        {current ? `${current.hostname} · ${current.rootPath}` : "Choose folder"}
      </span>
    </WorkbenchPressDragMenu>
  );
}
