/* Exports: default WorkbenchGitFileList: the working tree's files: unclaimed ones to include, range-pick and stash or discard, then each claiming thread's inspect-only group. */
"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkingTreeFile, WorkingTreeMutation } from "workbench-shared/workbench/git/working-tree-contracts";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import Disclosure from "../../ui/Disclosure";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import { GitStashIcon, OpenThreadIcon, Trash2Icon } from "../workbench-icons";
import { useGitOwnerHref } from "./use-git-owner-href";
import WorkbenchGitFileRow, { WorkbenchGitFileTotals } from "./WorkbenchGitFileRow";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

type ActionScope = Pick<WorkingTreeMutation, "rootId" | "expectedHead" | "selections">;
const DISCARD_HOLD_MS = 1_000;
const FILTER_FROM = 12;

export default function WorkbenchGitFileList({ onSelect }: { onSelect(): void }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const menu = useWorkbenchContextMenu();
  const ownerHref = useGitOwnerHref();
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const repository = state.repository;
  const all = repository?.files ?? [];
  const query = filter.toLowerCase();
  const files = all.filter(file => file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query));
  const unclaimed = files.filter(file => !file.ownerIds.length);
  const allUnclaimed = all.filter(file => !file.ownerIds.length);
  const ownerIds = [...new Set(files.flatMap(file => file.ownerIds))];
  const included = new Set(snapshot.selections.map(selection => selection.path));
  const everyIncluded = allUnclaimed.length > 0 && allUnclaimed.every(file => included.has(file.path))
    && snapshot.selections.every(selection => selection.lineIds === null);
  useEffect(() => { setPicked([]); anchor.current = null; }, [snapshot.rootId]);

  const select = (file: WorkingTreeFile, event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => {
    const paths = unclaimed.map(candidate => candidate.path);
    if (event.shiftKey && anchor.current && paths.includes(anchor.current) && paths.includes(file.path)) {
      const left = paths.indexOf(anchor.current);
      const right = paths.indexOf(file.path);
      setPicked(paths.slice(Math.min(left, right), Math.max(left, right) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      setPicked(previous => previous.includes(file.path) ? previous.filter(path => path !== file.path) : [...previous, file.path]);
      anchor.current = file.path;
    } else {
      setPicked([]);
      anchor.current = file.path;
    }
    state.selectFile(file.path);
    onSelect();
  };

  const context = (file: WorkingTreeFile, event: MouseEvent) => {
    event.preventDefault();
    if (file.ownerIds.length || !repository) return;
    const paths = picked.includes(file.path) ? picked : [file.path];
    setPicked(paths);
    const selected = repository.files.filter(candidate => paths.includes(candidate.path));
    const scope: ActionScope = {
      rootId: repository.rootId, expectedHead: repository.head,
      selections: selected.map(candidate => ({ path: candidate.path, identity: candidate.identity, lineIds: null })),
    };
    const disabled = state.mutationBlocked || Boolean(repository.blockedReason) || selected.some(candidate => candidate.ownerIds.length > 0);
    const count = selected.length === 1 ? "" : ` ${selected.length} files`;
    menu.openContextMenu({
      x: event.clientX, y: event.clientY, menu: {
        id: "working-tree-files", label: "File actions",
        items: [
          { id: "stash", icon: <GitStashIcon size={16} />, label: `Stash${count}`, disabled: disabled || !repository.head,
            onSelect: () => { void state.submit("stash", scope); } },
          { id: "discard", icon: <Trash2Icon size={16} />, label: `Discard${count}`, disabled, tone: "danger",
            holdToConfirmMs: DISCARD_HOLD_MS, onSelect: () => { void state.submit("discard", scope); } },
        ],
      },
    });
  };

  const row = (file: WorkingTreeFile) => {
    const selection = snapshot.selections.find(candidate => candidate.path === file.path);
    const locked = file.ownerIds.length > 0;
    return <WorkbenchGitFileRow key={file.path} file={file} active={snapshot.path === file.path}
      highlighted={picked.includes(file.path)}
      onSelect={event => select(file, event)} onContextMenu={event => context(file, event)}
      leading={locked ? null : <WorkbenchCheckbox className="shrink-0 block!" disabled={snapshot.busy}
        label={<span className="sr-only">Include {file.path}</span>}
        checked={included.has(file.path)} indeterminate={selection?.lineIds !== null && selection?.lineIds !== undefined}
        onChange={() => state.toggleFile(file.path)} />} />;
  };

  return <div data-git-file-list className="flex min-h-0 flex-1 flex-col">
    {all.length >= FILTER_FROM ? <input aria-label="Filter files" placeholder="Filter" value={filter} onChange={event => setFilter(event.target.value)}
      className="mx-1 mb-1 rounded-lg bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-fg/32 focus:bg-accent-soft" /> : null}
    {allUnclaimed.length ? <div className="mb-1 flex items-center gap-2 px-2 text-xs text-fg/muted">
      <WorkbenchCheckbox className="shrink-0 block!" label={<span className="sr-only">Include every unclaimed file</span>}
        disabled={snapshot.busy} checked={everyIncluded} indeterminate={snapshot.selections.length > 0 && !everyIncluded}
        onChange={checked => state.selectAll(checked)} />
      <span className="flex-1 tabular-nums">{snapshot.selections.length}/{allUnclaimed.length}</span>
      <WorkbenchGitFileTotals files={allUnclaimed} />
    </div> : null}
    <div className="scrollbar-hover-reveal min-h-0 flex-1 overflow-y-auto">
      {unclaimed.map(row)}
      {ownerIds.map(id => {
        const owner = repository?.owners.find(candidate => candidate.id === id);
        const href = ownerHref(owner);
        const claimed = files.filter(file => file.ownerIds.includes(id));
        return <Disclosure key={id} className="mt-1" summaryClassName="py-1" summary={owner ? (
          <WorkbenchThreadListItem entry={owner.entry} projectId={ProjectIdSchema.parse(owner.projectId)}
            compact={false} presentation="disclosure-summary" href={undefined}
            action={href ? { Icon: OpenThreadIcon, label: "Open", href } : undefined} />
        ) : <span className="text-sm text-fg/muted">{claimed.length} claimed</span>}>
          {claimed.map(row)}
        </Disclosure>;
      })}
    </div>
  </div>;
}
