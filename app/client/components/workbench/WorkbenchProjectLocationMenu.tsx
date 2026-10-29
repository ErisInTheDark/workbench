/*
 * Exports:
 * - default WorkbenchProjectLocationMenu: choose one available folder from the selectable folder universe, newest thread launch first.
 */
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import PressDragMenu from "../ui/PressDragMenu";
import WorkbenchClientContext from "./workbench-client-context";
import WorkbenchProjectLocationLabel from "./WorkbenchProjectLocationLabel";
import WorkbenchThreadOwnerLabel from "./WorkbenchThreadOwnerLabel";
import { FolderOpenIcon } from "./workbench-icons";

const noSubscription = () => () => {};

function folderDisplayPath(folder: ProjectFolderOption) {
  return folder.displayPath ?? `${folder.hostname}:${folder.rootPath}`;
}

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
  const presentation = useContext(WorkbenchClientContext)?.mounted?.presentationClient ?? null;
  const readLaunches = useCallback(() => presentation?.snapshot().data?.recentLaunches, [presentation]);
  const launches = useSyncExternalStore(presentation?.subscribe ?? noSubscription, readLaunches, readLaunches);
  const current = folders.find(folder =>
    folder.target.daemonId === selected?.daemonId && folder.target.projectId === selected?.projectId);
  const ordered = ProjectFolderOption.byRecentLaunch(
    folders.filter(folder => folder.project || folder === current), launches ?? []);
  return (
    <PressDragMenu
      label={label}
      items={ordered.map(folder => ({
        id: `${folder.target.daemonId}/${folder.target.projectId}`,
        checked: folder === current,
        content: (
          <span className="flex min-w-0 flex-col text-left">
            <WorkbenchThreadOwnerLabel
              owner={{ ...folder.target, hostname: folder.hostname, rootPath: folder.rootPath, displayPath: folderDisplayPath(folder) }}
              project={folder.project}
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
        {current ? <WorkbenchProjectLocationLabel displayPath={folderDisplayPath(current)} hostname={current.hostname} /> : "Choose folder"}
      </span>
    </PressDragMenu>
  );
}
