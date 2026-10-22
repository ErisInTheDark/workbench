/* Exports: default WorkbenchGitRepositoryControl: pick which of a multi-root folder's repositories the changes view shows; absent for one repository. */
"use client";
import PressDragMenu from "../../ui/PressDragMenu";
import { ChevronDownIcon, FolderGit2Icon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitRepositoryControl() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const repositories = snapshot.data.repositories;
  if (repositories.length < 2) return null;
  return <PressDragMenu label="Repository" align="start" disabled={snapshot.busy} triggerClassName="text-text"
    items={repositories.map(repository => ({
      id: repository.rootId, checked: repository.rootId === snapshot.rootId,
      content: <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{repository.label}</span>
        {repository.files.some(file => !file.ownerIds.length) ? <span className="text-xs tabular-nums text-fg/muted">
          {repository.files.filter(file => !file.ownerIds.length).length}
        </span> : null}
      </span>,
    }))}
    onSelect={rootId => state.selectRoot(rootId)}>
    <FolderGit2Icon size={16} className="shrink-0" />
    <span className="min-w-0 max-w-48 truncate">{state.repository?.label}</span>
    <ChevronDownIcon size={14} className="shrink-0 text-fg/muted" />
  </PressDragMenu>;
}
