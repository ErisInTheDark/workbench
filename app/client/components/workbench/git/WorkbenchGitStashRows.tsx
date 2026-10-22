/*
 * Exports: default WorkbenchGitStashRows: a folder's stashes as sidebar rows that open each one in a git tab, with a hover
 * card and a right-click menu; older ones fold behind a count.
 */
"use client";
import { memo, useMemo, useState, type MouseEvent } from "react";
import type { GitStashEntry } from "workbench-shared/workbench/git/git-object-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitStashes } from "../../../workbench/git/use-git-refs";
import Tooltip from "../../ui/Tooltip";
import { formatThreadRelativeTimestamp } from "../thread-view/thread-view-formatters";
import { ChevronDownIcon, GitStashIcon } from "../workbench-icons";
import type { GitMenuObject } from "./use-git-object-menu";
import WorkbenchGitObjectTooltip from "./WorkbenchGitObjectTooltip";

const SHOWN = 2;

const StashRow = memo(function StashRow({ location, stash, active, href, onMenu }: {
  location: ProjectLocationReference;
  stash: GitStashEntry;
  active: boolean;
  href: string | undefined;
  onMenu(event: MouseEvent, object: GitMenuObject): void;
}) {
  const object = useMemo<GitMenuObject>(() => ({ kind: "stash", sha: stash.sha, named: Boolean(stash.message) }),
    [stash.message, stash.sha]);
  return <li>
    <Tooltip placement="right" content={<WorkbenchGitObjectTooltip location={location} object={object} subject={stash.message} at={stash.createdAt} />}>
      <a href={href} aria-current={active ? "page" : undefined} onContextMenu={event => onMenu(event, object)} className={`
        flex min-h-8 items-center gap-2 rounded-lg px-2 text-[0.84rem]
        ${active ? "bg-fg/5 text-text" : "text-fg/muted hover:bg-fg/3 hover:text-text"}
      `}>
        <GitStashIcon size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{stash.message || <em>unnamed stash</em>}</span>
        <span className="shrink-0 text-[0.72rem] text-fg/muted">{formatThreadRelativeTimestamp(stash.createdAt / 1000, Date.now(), "short")}</span>
      </a>
    </Tooltip>
  </li>;
});

export default function WorkbenchGitStashRows({ location, href, activeSha, onMenu }: {
  location: ProjectLocationReference;
  href(sha: string): string | undefined;
  /** The stash the focused git tab shows. */
  activeSha: string | null;
  onMenu(event: MouseEvent, object: GitMenuObject): void;
}) {
  const list = useGitStashes(location);
  const [open, setOpen] = useState(false);
  if (!list?.stashes.length) return null;
  const active = list.stashes.findIndex(stash => stash.sha === activeSha);
  // An open stash stays visible even while the older ones are folded.
  const shown = open ? list.stashes : list.stashes.filter((_, index) => index < SHOWN || index === active);
  const hidden = list.stashes.length - shown.length;
  return <ol aria-label="Stashes" className="m-0 mb-1 list-none p-0">
    {shown.map(stash => <StashRow key={stash.sha} location={location} stash={stash} active={stash.sha === activeSha}
      href={href(stash.sha)} onMenu={onMenu} />)}
    {hidden > 0 || open && list.stashes.length > SHOWN ? <li>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 text-[0.76rem] text-fg/muted hover:bg-fg/3 hover:text-text">
        <ChevronDownIcon size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        <span>{open ? "" : `+${hidden}`}</span>
      </button>
    </li> : null}
  </ol>;
}
