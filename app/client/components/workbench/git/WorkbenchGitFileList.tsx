/* Exports: default WorkbenchGitFileList: own file navigation, range selection and claimed-thread disclosures. */
"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkingTreeFile, WorkingTreeMutation } from "workbench-shared/workbench/git/working-tree-contracts";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import ThreadDisclosure from "../thread-view/ThreadDisclosure";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon, OpenThreadIcon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

type ActionScope = Pick<WorkingTreeMutation, "rootId" | "expectedHead" | "selections">;
const STATUS_ICONS = { A: FileAddIcon, D: FileDeleteIcon, R: FileMoveIcon, M: FileUpdateIcon, T: FileUpdateIcon };

export default function WorkbenchGitFileList ({ onSelect }: { onSelect (): void }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const menu = useWorkbenchContextMenu();
  const projectHref = useWorkbenchProjectNavigation();
  const [filter, setFilter] = useState("");
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [discard, setDiscard] = useState<ActionScope | null>(null);
  const repository = state.repository;
  const files = repository?.files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())
    || file.oldPath?.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const unclaimed = files.filter(file => !file.ownerIds.length);
  const ownerIds = [...new Set(files.flatMap(file => file.ownerIds))];
  const included = new Set(snapshot.selections.map(selection => selection.path));
  useEffect(() => { if (discard) dialog.current?.showModal(); }, [discard]);
  useEffect(() => { setSelectedRows([]); anchor.current = null; }, [snapshot.rootId]);
  const visibleButtons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-git-file]") ?? [])]
    .filter(button => button.getClientRects().length);

  const select = (file: WorkingTreeFile, event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => {
    const paths = [...new Set(visibleButtons().map(button => button.dataset.gitFile))];
    if (event.shiftKey && anchor.current && paths.includes(anchor.current)) {
      const left = paths.indexOf(anchor.current);
      const right = paths.indexOf(file.path);
      setSelectedRows(paths.slice(Math.min(left, right), Math.max(left, right) + 1).filter((path): path is string => Boolean(path)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedRows(previous => previous.includes(file.path) ? previous.filter(path => path !== file.path) : [...previous, file.path]);
      anchor.current = file.path;
    } else {
      setSelectedRows([file.path]);
      anchor.current = file.path;
    }
    state.selectFile(file.path);
    onSelect();
  };
  const context = (file: WorkingTreeFile, event: MouseEvent) => {
    event.preventDefault();
    if (file.ownerIds.length || !repository) return;
    const paths = selectedRows.includes(file.path) ? selectedRows : [file.path];
    setSelectedRows(paths);
    const selected = repository.files.filter(file => paths.includes(file.path));
    const scope: ActionScope = {
      rootId: repository.rootId, expectedHead: repository.head,
      selections: selected.map(file => ({ path: file.path, identity: file.identity, lineIds: null })),
    };
    const disabled = state.mutationBlocked || Boolean(repository.blockedReason) || selected.some(file => file.ownerIds.length > 0);
    menu.openContextMenu({
      x: event.clientX, y: event.clientY, menu: {
        id: "working-tree-files", label: "Selected file actions",
        items: [
          { id: "stash", label: `Stash ${selected.length} files`, disabled: disabled || !repository.head, onSelect: () => { void state.submit("stash", scope); } },
          { id: "discard", label: `Discard ${selected.length} files`, disabled, tone: "danger", onSelect: () => setDiscard(scope) },
        ],
      }
    });
  };
  const row = (file: WorkingTreeFile) => {
    const selection = snapshot.selections.find(selection => selection.path === file.path);
    const partial = selection?.lineIds !== null && selection?.lineIds !== undefined;
    const Icon = STATUS_ICONS[file.status];
    const active = snapshot.path === file.path;
    const locked = file.ownerIds.length > 0;
    return <div key={file.path} className={`
      flex min-w-0 items-center gap-1 rounded-lg px-1 py-1
      ${active || selectedRows.includes(file.path) ? "bg-accent-soft" : "hover:bg-accent-soft/40"}
    `} onContextMenu={event => context(file, event)}>
      <WorkbenchCheckbox className="shrink-0 block!" label={<span className="sr-only">Include {file.path}</span>} disabled={locked || snapshot.busy}
        checked={included.has(file.path)} indeterminate={partial}
        onChange={() => state.toggleFile(file.path)} />
      <button type="button" data-git-file={file.path}
        aria-current={active ? "true" : undefined}
        aria-pressed={selectedRows.includes(file.path)}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
        onClick={event => select(file, event)}
        onKeyDown={event => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const buttons = visibleButtons();
          const index = buttons.indexOf(event.currentTarget);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
          const button = buttons[next];
          const target = files.find(file => file.path === button?.dataset.gitFile);
          if (target) { select(target, event); button?.focus(); button?.scrollIntoView({ block: "nearest" }); }
        }}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{file.path.split("/").at(-1)}</span>
          <span className="block truncate text-xs text-fg/muted">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
          <span className="flex gap-2 text-xs tabular-nums">
            <Icon size={12} className="mt-0.75 shrink-0 text-fg/muted" />
            {file.additions !== null ? <span className="text-emerald-700 dark:text-emerald-300">+{file.additions}</span> : <span className="text-fg/muted">Binary</span>}
            {file.deletions !== null ? <span className="text-red-700 dark:text-red-300">−{file.deletions}</span> : null}
          </span>
        </span>
      </button>
    </div>;
  };
  return <div ref={list} className="flex min-h-0 flex-1 flex-col">
    <input aria-label="Filter changed files" placeholder="Filter files" value={filter} onChange={event => setFilter(event.target.value)}
      className="mx-2 mb-2 rounded-lg bg-transparent px-2 py-2 text-sm outline-none focus:bg-accent-soft" />
    <div className="mb-2 px-1">
      <WorkbenchCheckbox label="All unclaimed files" disabled={snapshot.busy || !repository?.files.some(file => !file.ownerIds.length)}
        checked={Boolean(repository?.files.some(file => !file.ownerIds.length)) && repository!.files.filter(file => !file.ownerIds.length).every(file => included.has(file.path)) && snapshot.selections.every(selection => selection.lineIds === null)}
        indeterminate={snapshot.selections.length > 0 && (snapshot.selections.length !== repository?.files.filter(file => !file.ownerIds.length).length || snapshot.selections.some(selection => selection.lineIds !== null))}
        onChange={checked => state.selectAll(checked)} />
    </div>
    <div className="scrollbar-hover-reveal min-h-0 flex-1 overflow-y-auto">
      {unclaimed.map(row)}
      {!unclaimed.length ? <p className="px-3 text-sm text-fg/muted">No unclaimed files{filter ? " match this filter" : ""}.</p> : null}
      {ownerIds.map(id => {
        const owner = repository?.owners.find(owner => owner.id === id);
        const target = owner?.entry.entryKind !== "draft" ? owner?.entry.identity : null;
        const href = owner && target ? projectHref(createThreadRoute(owner.projectId, { kind: "provider", ...target })) : undefined;
        return <ThreadDisclosure key={id} summaryClassName="py-1" summary={owner ? (
          <WorkbenchThreadListItem entry={owner.entry} projectId={ProjectIdSchema.parse(owner.projectId)}
            compact={false} presentation="disclosure-summary" href={undefined} showTooltip={false}
            action={href ? {
              Icon: OpenThreadIcon, label: "Open", href, onClick: event => {
                if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                window.history.pushState({ workbench: true }, "", href);
              }
            } : undefined} />
        ) : <span className="text-sm text-fg/muted">Claimed thread unavailable</span>}>
          {files.filter(file => file.ownerIds.includes(id)).map(row)}
        </ThreadDisclosure>;
      })}
    </div>
    <dialog ref={dialog} onClose={() => setDiscard(null)} className="max-w-md rounded-2xl bg-bg p-6 text-text shadow-float backdrop:bg-black/40">
      <form method="dialog" className="space-y-4">
        <h2 className="text-lg font-semibold">Discard selected file changes?</h2>
        <p className="text-sm">This removes all reviewed changes in {discard?.selections.length ?? 0} selected files. It cannot be undone here.</p>
        <div className="flex justify-end gap-3">
          <button className="rounded-lg px-3 py-2 hover:bg-accent-soft" autoFocus>Cancel</button>
          <button className="rounded-lg px-3 py-2 text-danger hover:bg-accent-soft disabled:opacity-45" disabled={state.mutationBlocked}
            onClick={() => { if (discard) void state.submit("discard", discard); }}>Discard changes</button>
        </div>
      </form>
    </dialog>
  </div>;
}
