/*
 * Exports:
 * - default ThreadGitArcMoveList: render clickable source-to-destination rows for Git arc move previews and results.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import ProjectFilePath from "../ProjectFilePath";
import { ArrowRightIcon } from "../workbench-icons";

export default function ThreadGitArcMoveList({
  inset = true,
  mappings,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inset?: boolean;
  mappings: readonly { destination: string; source: string }[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!mappings.length) return null;
  const displayMappings = mappings.map(({ destination, source }) => ({
    destination: toWorkspaceDisplayPath(destination, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? destination,
    source: toWorkspaceDisplayPath(source, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? source,
  }));
  const moveDisambiguationPaths = displayMappings.flatMap(({ destination, source }) => [source, destination]);
  return (
    <div className="space-y-1 py-2">
      {displayMappings.map(({ destination, source }) => (
        <div className={`flex min-w-0 items-center gap-1.5 py-0.5 text-[0.86em] leading-[1.5] text-fg/muted ${inset ? "pl-6" : ""}`} key={`${source}\0${destination}`}>
          <ProjectFilePath className="min-w-0 max-w-[45%] shrink align-baseline text-[0.9em]" disambiguationPaths={moveDisambiguationPaths} path={source} projectId={projectId} />
          <ArrowRightIcon className="shrink-0" size={14} />
          <ProjectFilePath className="min-w-0 max-w-[45%] shrink align-baseline text-[0.9em]" disambiguationPaths={moveDisambiguationPaths} path={destination} projectId={projectId} />
        </div>
      ))}
    </div>
  );
}
