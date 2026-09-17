/* Exports: default WorkbenchGitRepositoryControl: repository navigation and branch metadata within the shell header. */
"use client";
import PrimaryButton from "../PrimaryButton";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import WorkbenchTag from "../WorkbenchTag";
import { ChevronDownIcon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitRepositoryControl () {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const menu = useWorkbenchContextMenu();
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    {snapshot.data.repositories.length > 1 ? <PrimaryButton aria-label="Git repository" disabled={snapshot.busy}
      onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        menu.openContextMenu({
          x: bounds.left, y: bounds.bottom, menu: {
            id: "working-tree-repositories", label: "Git repository",
            items: snapshot.data.repositories.map(repository => ({
              id: repository.rootId, label: repository.label,
              onSelect: () => state.selectRoot(repository.rootId),
            })),
          }
        });
      }}>
      <span className="max-w-48 truncate">{state.repository?.label}</span><ChevronDownIcon size={14} />
    </PrimaryButton> : null}
    {snapshot.initialising && !state.repository ? <span aria-label="Loading repository" className="inline-block h-5 w-16 rounded-full workbench-skeleton" />
      : <>
        <WorkbenchTag>{state.repository?.branch ?? (state.repository?.head ? "Detached HEAD" : "Working-tree changes")}</WorkbenchTag>
        {snapshot.result && <span>{snapshot.result.message}</span>}
      </>}
  </span>;
}
