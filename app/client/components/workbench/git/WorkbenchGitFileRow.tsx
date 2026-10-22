/*
 * Exports:
 * - default WorkbenchGitFileRow: one changed file (name, folder, change kind and line counts) as a focusable row, with an
 *   optional leading control; arrow keys, Home and End walk the rows of its list.
 * - WorkbenchGitFileTotals: summed added and removed lines for a set of files.
 */
"use client";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { GitChangesetFile } from "../../../workbench/git/git-changeset";
import Tooltip from "../../ui/Tooltip";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon } from "../workbench-icons";

const STATUS = {
  A: { Icon: FileAddIcon, label: "Added" },
  D: { Icon: FileDeleteIcon, label: "Deleted" },
  R: { Icon: FileMoveIcon, label: "Renamed" },
  M: { Icon: FileUpdateIcon, label: "Modified" },
  T: { Icon: FileUpdateIcon, label: "Type changed" },
} as const;

export function WorkbenchGitFileTotals({ files }: { files: readonly Pick<GitChangesetFile, "additions" | "deletions">[] }) {
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return <span className="inline-flex gap-2 text-xs tabular-nums">
    <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
    <span className="text-red-700 dark:text-red-300">−{removed}</span>
  </span>;
}

/** Moves focus between rows sharing the nearest `[data-git-file-list]`, selecting as it goes. */
function walk(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const rows = [...event.currentTarget.closest("[data-git-file-list]")?.querySelectorAll<HTMLButtonElement>("button[data-git-file]") ?? []]
    .filter(row => row.getClientRects().length);
  const index = rows.indexOf(event.currentTarget);
  const next = rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
    : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
  next?.click();
}

export default function WorkbenchGitFileRow({ file, active, highlighted = false, leading, onSelect, onContextMenu }: {
  file: GitChangesetFile;
  active: boolean;
  /** Part of a multi-row pick for a context action. */
  highlighted?: boolean;
  leading?: ReactNode;
  onSelect(event: MouseEvent<HTMLButtonElement>): void;
  onContextMenu?(event: MouseEvent<HTMLElement>): void;
}) {
  const { Icon, label } = STATUS[file.status];
  const slash = file.path.lastIndexOf("/");
  return <div onContextMenu={onContextMenu} className={`
    flex min-w-0 items-center gap-1 rounded-lg px-1
    ${active || highlighted ? "bg-accent-soft" : "hover:bg-accent-soft/40"}
  `}>
    {leading}
    <button type="button" data-git-file={file.path} aria-current={active ? "true" : undefined}
      className="flex min-w-0 flex-1 items-start gap-2 rounded-lg py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      onClick={onSelect} onKeyDown={walk}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{file.path.slice(slash + 1)}</span>
        {slash >= 0 || file.oldPath ? <span className="block truncate text-xs text-fg/muted">
          {file.oldPath ? `${file.oldPath} → ` : ""}{slash >= 0 ? file.path.slice(0, slash) : ""}
        </span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs tabular-nums">
        {file.binary ? null : <>
          {file.additions ? <span className="text-emerald-700 dark:text-emerald-300">+{file.additions}</span> : null}
          {file.deletions ? <span className="text-red-700 dark:text-red-300">−{file.deletions}</span> : null}
        </>}
        <Tooltip content={file.binary ? `${label} · binary` : label} placement="top">
          <span className="inline-flex text-fg/muted"><Icon size={12} /></span>
        </Tooltip>
      </span>
    </button>
  </div>;
}
