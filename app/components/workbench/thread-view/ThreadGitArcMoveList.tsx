/*
 * Exports:
 * - default ThreadGitArcMoveList: render clickable source-to-destination rows for Git arc move previews and results. Keywords: thread, git, arc, move, file list.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import ProjectFilePath from "../ProjectFilePath";

export default function ThreadGitArcMoveList({
  mappings,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
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
        <div className="flex min-w-0 items-center gap-1.5 py-0.5 pl-6 text-[0.86em] leading-[1.5] text-muted" key={`${source}\0${destination}`}>
          <ProjectFilePath className="min-w-0 max-w-[45%] shrink align-baseline text-[0.9em]" disambiguationPaths={moveDisambiguationPaths} path={source} projectId={projectId} />
          <svg aria-hidden="true" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
          <ProjectFilePath className="min-w-0 max-w-[45%] shrink align-baseline text-[0.9em]" disambiguationPaths={moveDisambiguationPaths} path={destination} projectId={projectId} />
        </div>
      ))}
    </div>
  );
}
