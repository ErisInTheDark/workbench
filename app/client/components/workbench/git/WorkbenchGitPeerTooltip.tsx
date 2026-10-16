/* Exports: default WorkbenchGitPeerTooltip: demand transferable commits while the sync tooltip is open, expanding history through Disclosure. */
"use client";

import { useMemo, useState } from "react";
import type { GitPeerAddress, GitPeerTransfer } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import Disclosure from "../../ui/Disclosure";
import ThreadCheckpointCommitCard from "../thread-view/ThreadCheckpointCommitCard";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { GitFastForwardIcon, GitMergeIcon, GitRebaseIcon } from "../workbench-icons";

export default function WorkbenchGitPeerTooltip({ location, peer, hostname, branch, action, mode, unavailable }: {
  location: ProjectLocationReference;
  peer: GitPeerAddress;
  hostname: string;
  branch: string | null;
  action: "pull" | "send";
  mode: GitPeerTransfer["mode"];
  unavailable: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useMemo(() => branch && !unavailable ? {
    kind: "gitPeerCommits" as const,
    location: { daemonId: location.daemonId, projectId: location.projectId },
    peer: { daemonId: peer.daemonId, projectId: peer.projectId },
    branch, action, all: false,
  } : null, [location.daemonId, location.projectId, peer.daemonId, peer.projectId, branch, action, unavailable]);
  const workspace = useWorkbenchWorkspace();
  const snapshot = useWorkspaceObservation(workspace, query);
  const fullQuery = useMemo(() => expanded && query ? { ...query, all: true } : null, [expanded, query]);
  const full = useWorkspaceObservation(workspace, fullQuery);
  const data = snapshot.value?.data;
  const remaining = full.value?.data;
  const Icon = mode === "fastForward" ? GitFastForwardIcon : mode === "merge" ? GitMergeIcon : GitRebaseIcon;
  const row = (commit: NonNullable<typeof data>["commits"][number]) => <ThreadCheckpointCommitCard key={commit.commit}
    sourceItemId={`peer-commit:${commit.commit}`}
    state={{ status: "summary", summary: { changes: null, committedSha: commit.commit, description: "", title: commit.subject } }} />;
  const loadingRow = <ThreadCheckpointCommitCard sourceItemId="peer-commit:loading" state={{ status: "pending" }} />;
  const failure = unavailable ?? (!branch ? "Branch unavailable"
    : snapshot.phase === "failed" || snapshot.phase === "unavailable" ? "Commits unavailable" : null);
  return <div className="w-[min(26rem,80vw)]">
    <div className="mb-2 flex items-center gap-2 font-medium">
      <Icon size={16} />
      <span>{mode === "fastForward" ? "Fast-forward" : mode === "merge" ? "Merge" : "Rebase"} {action === "pull" ? "from" : "to"} {hostname}</span>
    </div>
    {failure ? <p className="m-0 text-fg/muted">{failure}</p>
      : !data ? <div aria-label="Loading commits">
        {loadingRow}{loadingRow}{loadingRow}
      </div> : <>
        {snapshot.phase === "stale" ? <p className="m-0 mb-1 text-fg/muted">Preview out of date</p> : null}
        {data.total === 0 ? <p className="m-0 text-fg/muted">No new commits</p> : data.commits.slice(0, 3).map(row)}
        {data.total > 3 ? <Disclosure open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}
          summary={`${data.total - 3} more commits`} summaryClassName="mt-1 py-1 text-xs">
          {full.phase === "failed" || full.phase === "unavailable"
            ? <p className="m-0 py-1 text-fg/muted">Commits unavailable</p>
            : remaining?.head === data.head && remaining.tip === data.tip
              ? remaining.commits.slice(3).map(row)
              : loadingRow}
        </Disclosure> : null}
      </>}
  </div>;
}
