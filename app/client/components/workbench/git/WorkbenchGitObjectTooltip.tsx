/*
 * Exports:
 * - default WorkbenchGitObjectTooltip: a commit's or stash's hover card: message, committing threads, author, age, sha,
 *   changed files with line totals, and where a commit still has to go. The full detail loads when the card opens.
 */
"use client";
import { useEffect, useState } from "react";
import type { GitObjectDetail, GitObjectRef } from "workbench-shared/workbench/git/git-object-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { readGitObjectDetail } from "../../../workbench/git/git-object-details";
import { formatLongTimestamp, formatThreadRelativeTimestamp } from "../thread-view/thread-view-formatters";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { ArrowUpIcon, SendHorizontalIcon } from "../workbench-icons";
import { WorkbenchGitFileTotals } from "./WorkbenchGitFileRow";
import WorkbenchGitThreadChip from "./WorkbenchGitThreadChip";

export default function WorkbenchGitObjectTooltip({ location, object, subject, author, at, unpushed = false, unsent = false }: {
  location: ProjectLocationReference;
  object: GitObjectRef;
  subject: string;
  author?: string;
  /** Epoch milliseconds. */
  at: number;
  unpushed?: boolean;
  unsent?: boolean;
}) {
  const daemon = useWorkbenchDaemonClient();
  const [detail, setDetail] = useState<GitObjectDetail | null>(null);
  useEffect(() => {
    let live = true;
    void readGitObjectDetail(daemon, location, { kind: object.kind, sha: object.sha }).then(value => { if (live) setDetail(value); }, () => undefined);
    return () => { live = false; };
  }, [daemon, location.daemonId, location.projectId, object.kind, object.sha]);
  const files = detail?.files.length ?? 0;
  return <div className="w-[min(26rem,80vw)] space-y-2 py-0.5">
    <div className="space-y-1">
      <p className="m-0 font-medium leading-snug text-text">
        {subject || <em className="font-normal text-fg/muted">{object.kind === "stash" ? "unnamed stash" : "no message"}</em>}
      </p>
      {detail?.body ? <p className="m-0 line-clamp-8 whitespace-pre-wrap text-[0.8rem] leading-snug text-fg/muted">{detail.body}</p> : null}
    </div>
    {detail?.threads.length ? <div className="flex flex-wrap gap-1 text-[0.8rem]">
      {detail.threads.map(owner => <WorkbenchGitThreadChip key={owner.id} owner={owner} />)}
    </div> : null}
    <div className="flex items-baseline gap-2 text-[0.78rem] text-fg/muted">
      <span className="min-w-0 truncate">
        {author ? <><span className="text-text">{author}</span> · </> : null}
        {formatThreadRelativeTimestamp(at / 1000, Date.now())}
      </span>
      <span className="ml-auto shrink-0 font-mono">{object.sha.slice(0, 7)}</span>
    </div>
    <div className="flex items-center gap-2 border-t border-fg/8 pt-1.5 text-[0.76rem] text-fg/muted">
      <span>{formatLongTimestamp(at)}</span>
      {detail ? <span className="ml-auto inline-flex items-center gap-2">
        <span className="tabular-nums">{files} {files === 1 ? "file" : "files"}</span>
        <WorkbenchGitFileTotals files={detail.files} />
      </span> : <span className="ml-auto h-2.5 w-16 rounded workbench-skeleton" />}
    </div>
    {unpushed || unsent ? <div className="flex flex-wrap gap-3 text-[0.76rem] text-accent">
      {unpushed ? <span className="inline-flex items-center gap-1"><ArrowUpIcon size={12} />Not on upstream</span> : null}
      {unsent ? <span className="inline-flex items-center gap-1"><SendHorizontalIcon size={12} />Missing on a device</span> : null}
    </div> : null}
  </div>;
}
