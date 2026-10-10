/*
 * Exports:
 * - default ThreadGitArcEditDetails: render an edit session's file page, claim effects, blockers, conflicts and warnings.
 */
import type { GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import ThreadClaimedFileList, { type ThreadClaimMarker } from "./ThreadClaimedFileList";
import { ThreadFileChangeList, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";

export default function ThreadGitArcEditDetails({
  projectFilePaths,
  projectId,
  projectRootPath,
  result,
  rows,
  workspaceRoots,
}: {
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  result: GitArcEditResult;
  rows: ThreadFileChangeListChange[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const location = { projectFilePaths, projectId, projectRootPath, workspaceRoots };
  const groups: Array<{ label: string; marker: ThreadClaimMarker; paths: string[]; tone?: "danger" }> = [
    { label: "Claimed by other threads; apply waits", marker: "unclaimed", paths: result.collisions.flatMap(({ paths }) => paths) },
    { label: "Unclaimed dirty; apply rejects", marker: "dirty", paths: result.blockedDirtyPaths, tone: "danger" },
    { label: "Held by pending proposals; apply rejects", marker: "dirty", paths: result.blockedPendingPaths, tone: "danger" },
    { label: "Resolve conflict markers", marker: "dirty", paths: result.conflictedPaths },
    { label: "Claimed", marker: "claimed", paths: result.additionalClaims },
    { label: "Released", marker: "unclaimed", paths: result.releasedClaims },
  ];
  return (
    <div data-thread-git-arc-edit={result.phase}>
      <ThreadFileChangeList changes={rows} {...location} />
      {result.pageCount > 1 ? (
        <p className="m-0 pb-1 text-[0.78em] text-fg/muted">Page {result.page} of {result.pageCount} · {result.fileCount} files</p>
      ) : null}
      {groups.filter(({ paths }) => paths.length).map(({ label, marker, paths, tone }) => (
        <ThreadClaimedFileList key={label} label={label} marker={marker} paths={paths} tone={tone ?? "default"} {...location} />
      ))}
      {result.warnings.length ? (
        <ul className="m-0 list-none space-y-0.5 py-1 pl-6 text-[0.78em] text-fg/muted">
          {result.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
