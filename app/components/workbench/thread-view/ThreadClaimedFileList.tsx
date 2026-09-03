/*
 * Exports:
 * - default ThreadClaimedFileList: render static planned, claimed, or attempted Git arc path rows with optional failure tone. Keywords: thread, git, arc, plan, claim, file list, danger.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { isProjectDirectoryPath } from "../../../workbench/project/project-file-path";
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
  tone = "default",
  workspaceRoots,
}: {
  label?: string;
  marker?: "claimed" | "planned";
  paths: readonly string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  tone?: "danger" | "default";
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!paths.length) return null;
  return (
    <div className="space-y-1 py-2">
      {paths.map((filePath) => {
        const displayPath = toWorkspaceDisplayPath(filePath, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? filePath;
        const targetType = isProjectDirectoryPath(displayPath, projectFilePaths ?? []) ? "directory" : "file";
        return (
          <div
            className={`flex min-w-0 items-baseline gap-1 py-0.5 pl-6 text-[0.86em] leading-[1.5] ${tone === "danger" ? "text-danger" : "text-muted"}`}
            data-thread-git-arc-path-tone={tone}
            key={filePath}
          >
            <span className="-mt-0.5 inline-flex shrink-0 self-center" aria-hidden="true">
              {marker === "planned" ? <GitArcPlannedClaimIcon /> : <GitArcClaimIcon />}
            </span>
            <ThreadSummaryText text={label} />
            <ProjectFilePath className="min-w-0 max-w-full shrink align-baseline text-[0.9em]" disambiguationPaths={projectFilePaths} path={displayPath} projectId={projectId} targetType={targetType} />
          </div>
        );
      })}
    </div>
  );
}
