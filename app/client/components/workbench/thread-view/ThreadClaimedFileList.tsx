/*
 * Exports:
 * - default ThreadClaimedFileList: render static Git arc path rows with optional failure tone, change totals and an unlisted-path count.
 * - ThreadClaimMarker/ThreadClaimMarkerIcon: select the semantic glyph for a claim-state row.
 */
import { isProjectDirectoryPath } from "../../../workbench/project/project-file-path";
import ProjectFilePath from "../ProjectFilePath";
import { useProject } from "../use-projects";
import {
  GitArcClaimIcon,
  GitArcCleanClaimIcon,
  GitArcDirtyClaimIcon,
  GitArcPlanClaimIcon,
  GitArcUnclaimIcon,
} from "./GitArcIcon";
import { ThreadFileChangeTotals } from "./ThreadFileChangeItem";
import ThreadSummaryText from "./ThreadSummaryText";

export type ThreadClaimMarker = "claimed" | "clean" | "dirty" | "planned" | "unclaimed";

export function ThreadClaimMarkerIcon({ marker }: { marker: ThreadClaimMarker }) {
  if (marker === "clean") return <GitArcCleanClaimIcon size={20} />;
  if (marker === "dirty") return <GitArcDirtyClaimIcon size={20} />;
  if (marker === "planned") return <GitArcPlanClaimIcon size={20} />;
  if (marker === "unclaimed") return <GitArcUnclaimIcon size={20} />;
  return <GitArcClaimIcon size={20} />;
}

export default function ThreadClaimedFileList({
  inset = true,
  label = "Claimed",
  marker = "claimed",
  pathTotals,
  paths,
  tone = "default",
  totalCount = paths.length,
}: {
  inset?: boolean;
  label?: string;
  marker?: ThreadClaimMarker;
  pathTotals?: ReadonlyMap<string, { additions: number; deletions: number }>;
  paths: readonly string[];
  tone?: "danger" | "default";
  /** Exact total when `paths` lists only some of them. */
  totalCount?: number;
}) {
  const project = useProject.contextual();
  if (!paths.length) return null;
  const remainingCount = totalCount - paths.length;
  return (
    <div className="space-y-1 py-2">
      {paths.map((filePath) => {
        const displayPath = project ? project.displayPath(filePath) : filePath;
        const targetType = isProjectDirectoryPath(displayPath, project?.filePaths ?? []) ? "directory" : "file";
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
            <ProjectFilePath className="min-w-0 max-w-full shrink align-baseline text-[0.9em]" path={displayPath} targetType={targetType} />
            {totals ? <ThreadFileChangeTotals additions={totals.additions} deletions={totals.deletions} /> : null}
          </div>
        );
      })}
      {remainingCount > 0 ? (
        <div className={`text-[0.78em] leading-[1.6] text-fg/muted ${inset ? "pl-6" : ""}`}>...and {remainingCount} more</div>
      ) : null}
    </div>
  );
}
