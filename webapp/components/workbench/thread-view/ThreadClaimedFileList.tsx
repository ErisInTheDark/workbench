/*
 * Exports:
 * - default ThreadClaimedFileList: render static planned, claimed, or attempted Git arc path rows. Keywords: thread, git, arc, plan, claim, file list.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ProjectFilePath from "../ProjectFilePath";
import { GitArcClaimIcon, GitArcPlannedClaimIcon } from "./GitArcIcon";
import ThreadSummaryText from "./ThreadSummaryText";

export default function ThreadClaimedFileList({
  label = "Claimed",
  marker = "claimed",
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  label?: string;
  marker?: "claimed" | "planned";
  paths: readonly string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!paths.length) return null;
  return (
    <div className="space-y-1 py-2">
      {paths.map((filePath) => {
        const displayPath = toWorkspaceDisplayPath(filePath, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? filePath;
        return (
          <div className="flex min-w-0 items-baseline gap-1 py-0.5 pl-6 text-[0.86em] leading-[1.5] text-muted" key={filePath}>
            <span className="-mt-0.5 inline-flex shrink-0 self-center" aria-hidden="true">
              {marker === "planned" ? <GitArcPlannedClaimIcon /> : <GitArcClaimIcon />}
            </span>
            <ThreadSummaryText text={label} />
            <ProjectFilePath className="min-w-0 max-w-full shrink align-baseline text-[0.9em]" disambiguationPaths={projectFilePaths} path={displayPath} projectId={projectId} />
          </div>
        );
      })}
    </div>
  );
}
