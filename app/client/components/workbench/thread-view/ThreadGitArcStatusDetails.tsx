/*
 * Exports:
 * - default ThreadGitArcStatusDetails: render compact status and exact claim-loss evidence without inventing hidden paths.
 */
import { useEffect, useMemo } from "react";
import { parseGitArcStatus } from "workbench-shared/workbench/git/git-arc-status";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { CheckIcon, EllipsisIcon } from "../workbench-icons";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadClaimedFileList, { ThreadClaimMarkerIcon, type ThreadClaimMarker } from "./ThreadClaimedFileList";
import ThreadGitArcCommitList from "./ThreadGitArcCommitList";

export default function ThreadGitArcStatusDetails ({ output, projectFilePaths, projectId, projectRootPath, workspaceRoots }: {
  output: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const parsed = useMemo(() => parseGitArcStatus(output), [output]);
  useEffect(() => {
    if (!parsed.success) reportClientSchemaError("Git arc status output", parsed.error);
  }, [parsed]);
  if (!parsed.success) return <p className="text-danger">Status output could not be read.</p>;
  const status = parsed.data;
  const context = { projectFilePaths, projectId, projectRootPath, workspaceRoots };
  const group = (label: string, paths: number | string[], marker: ThreadClaimMarker) => typeof paths === "number"
    ? (
      <p className="m-0 flex items-center gap-1 py-1 text-fg/muted" key={label}>
        <span className="inline-flex shrink-0" aria-hidden="true"><ThreadClaimMarkerIcon marker={marker} /></span>
        <span>{label}: {paths}</span>
      </p>
    )
    : paths.length ? <ThreadClaimedFileList inset={false} key={label} label={label} marker={marker} paths={paths} {...context} /> : null;
  return (
    <div className="min-w-0 py-1">
      {status.pending.map(proposal => (
        <div className="flex min-w-0 items-start gap-2 py-0.5" key={proposal.proposalId}>
          <span className="sr-only">Pending</span>
          <EllipsisIcon className="mt-1.5 shrink-0 text-fg/muted" size={16} />
          <span className="min-w-0 break-words">{proposal.title}</span>
        </div>
      ))}
      {status.accepted.map(proposal => (
        <div className="flex min-w-0 items-baseline gap-2 py-0.5" key={proposal.proposalId}>
          <span className="sr-only">Accepted</span>
          <CheckIcon className="mt-1.5 shrink-0 self-start text-[color:var(--success)]" size={16} />
          <span className="shrink-0 font-mono text-fg/muted">{proposal.commitSha.slice(0, 8)}</span>
          <span className="min-w-0 break-words">{proposal.title}</span>
        </div>
      ))}
      {group("Dirty claims", status.dirtyClaims, "dirty")}
      {group("Clean claims", status.cleanClaims, "clean")}
      {group("Unclaimed dirt", status.unclaimedDirt, "unclaimed")}
      {status.recovery.map((lost, index) => (
        <section key={index}>
          {group("Lost claims", lost.paths, "unclaimed")}
          {lost.headMovement === "incompatible" ? <p className="text-danger">HEAD moved incompatibly since claim loss.</p> : null}
          {lost.commits.length ? <ThreadGitArcCommitList commits={lost.commits.map(commit => ({ ...commit, paths: commit.changedPaths }))} {...context} /> : null}
          {lost.omittedCommits ? <p className="text-fg/muted">{lost.omittedCommits} more intersecting commits</p> : null}
          {lost.comparison.length ? <ThreadCheckpointCompareItem changes={lost.comparison.map(change => ({
            ...change, status: change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "U",
          }))} {...context} /> : <p className="m-0 text-fg/muted">No changes since claim loss.</p>}
        </section>
      ))}
      {status.unavailableRecovery.length ? <p className="text-fg/muted">Claim-loss baseline unavailable for {status.unavailableRecovery.join(", ")}.</p> : null}
    </div>
  );
}
