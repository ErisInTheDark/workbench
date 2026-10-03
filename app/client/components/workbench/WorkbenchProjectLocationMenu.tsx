/*
 * Exports:
 * - default WorkbenchProjectLocationMenu: choose one concrete folder from the selectable folder universe.
 */
"use client";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import WorkbenchProjectLocationLabel from "./WorkbenchProjectLocationLabel";
import { FolderOpenIcon } from "./workbench-icons";

export default function WorkbenchProjectLocationMenu({
  folders,
  label,
  onSelect,
  selected,
}: {
  folders: readonly ProjectFolderOption[];
  label: string;
  onSelect: (location: ProjectLocationReference) => void;
  selected: ProjectLocationReference | null;
}) {
  const current = folders.find(folder =>
    folder.target.daemonId === selected?.daemonId && folder.target.projectId === selected?.projectId);
  const showOwners = new Set(folders.map(folder => folder.ownerProjectId)).size > 1;
  return (
    <WorkbenchPressDragMenu
      label={label}
      items={folders.map(folder => ({
        id: `${folder.target.daemonId}/${folder.target.projectId}`,
        checked: folder === current,
        content: (
          <span className="flex min-w-0 flex-col text-left" title={folder.rootPath}>
            {showOwners && folder.ownerLabel
              ? <span className="text-[0.72em] text-fg/muted">{folder.ownerLabel}</span>
              : null}
            <WorkbenchProjectLocationLabel
              displayPath={folder.displayPath ?? `${folder.hostname}:${folder.rootPath}`}
              hostname={folder.hostname}
            />
            {!folder.project ? <span className="text-[0.72em] text-danger">Unavailable</span> : null}
          </span>
        ),
      }))}
      onSelect={id => {
        const folder = folders.find(item => `${item.target.daemonId}/${item.target.projectId}` === id);
        if (folder) onSelect(folder.target);
      }}
    >
      <FolderOpenIcon className="shrink-0" size={16} />
      <span className="min-w-0 max-w-52 truncate" title={current?.rootPath}>
        {current ? <WorkbenchProjectLocationLabel
          displayPath={current.displayPath ?? `${current.hostname}:${current.rootPath}`}
          hostname={current.hostname}
        /> : "Choose folder"}
      </span>
    </WorkbenchPressDragMenu>
  );
}
