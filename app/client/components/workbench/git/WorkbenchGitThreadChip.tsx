/* Exports: default WorkbenchGitThreadChip: a thread named by its status glyph and title, linking to it when it resolves. */
"use client";
import type { GitCheckoutOwner } from "workbench-shared/workbench/git/git-object-contracts";
import { describeThreadEntry } from "../thread-entry-presentation";
import { useGitOwnerHref } from "./use-git-owner-href";

export default function WorkbenchGitThreadChip({ owner }: { owner: GitCheckoutOwner }) {
  const href = useGitOwnerHref()(owner);
  const shown = describeThreadEntry(owner.entry, {});
  const content = <>
    <shown.Icon size={14} className={`shrink-0 ${shown.statusClassName ?? ""}`} />
    <span className="min-w-0 truncate">{owner.entry.title || "Thread"}</span>
  </>;
  const className = "inline-flex min-w-0 max-w-64 items-center gap-1.5 rounded-full bg-fg/5 px-2 py-0.5 text-text";
  return href ? <a href={href} className={`${className} hover:bg-fg/8`}>{content}</a> : <span className={className}>{content}</span>;
}
