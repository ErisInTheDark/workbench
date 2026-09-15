/*
 * Exports:
 * - default ThreadClaimedFileList: render static Git arc path rows with optional failure tone and change totals.
 * - ThreadClaimMarker/ThreadClaimMarkerIcon: select the semantic glyph for a claim-state row.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { isProjectDirectoryPath } from "../../../workbench/project/project-file-path";
import ProjectFilePath from "../ProjectFilePath";
import {
  GitArcClaimIcon,
  GitArcCleanClaimIcon,
  GitArcDirtyClaimIcon,
  GitArcPlannedClaimIcon,
  GitArcUnclaimedIcon,
} from "./GitArcIcon";
import { ThreadFileChangeTotals } from "./ThreadFileChangeItem";
import ThreadSummaryText from "./ThreadSummaryText";

export type ThreadClaimMarker = "claimed" | "clean" | "dirty" | "planned" | "unclaimed";

export function ThreadClaimMarkerIcon({ marker }: { marker: ThreadClaimMarker }) {
  if (marker === "clean") return <GitArcCleanClaimIcon size={20} />;
  if (marker === "dirty") return <GitArcDirtyClaimIcon size={20} />;
  if (marker === "planned") return <GitArcPlannedClaimIcon size={20} />;
  if (marker === "unclaimed") return <GitArcUnclaimedIcon size={20} />;
  return <GitArcClaimIcon size={20} />;
}

export default function ThreadClaimedFileList({
  inset = true,
  label = "Claimed",
  marker = "claimed",
  pathTotals,
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  tone = "default",
  workspaceRoots,
}: {
  inset?: boolean;
  label?: string;
  marker?: ThreadClaimMarker;
  pathTotals?: ReadonlyMap<string, { additions: number; deletions: number }>;
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
        const totals = pathTotals?.get(filePath);
        return (
          <div
            className={`flex min-w-0 items-baseline gap-1 py-0.5 text-[0.86em] leading-[1.5] ${inset ? "pl-6" : ""} ${tone === "danger" ? "text-danger" : "text-fg/muted"}`}
            data-thread-git-arc-path-tone={tone}
            key={filePath}
          >
            <span className="-mt-0.5 inline-flex shrink-0 self-center" aria-hidden="true">
              <ThreadClaimMarkerIcon marker={marker} />
            </span>
            <ThreadSummaryText text={label} />
            <ProjectFilePath className="min-w-0 max-w-full shrink align-baseline text-[0.9em]" disambiguationPaths={projectFilePaths} path={displayPath} projectId={projectId} targetType={targetType} />
            {totals ? <ThreadFileChangeTotals additions={totals.additions} deletions={totals.deletions} /> : null}
          </div>
        );
      })}
    </div>
  );
}
