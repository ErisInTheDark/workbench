/*
 * Exports:
 * - default ThreadGitArcCommitList: share intersecting commit subjects and file links across arc cards.
 */
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import ProjectFileLinkList from "../ProjectFileLinkList";

export default function ThreadGitArcCommitList({
  commits, projectFilePaths, projectId, projectRootPath, workspaceRoots,
}: {
  commits: Array<{ commit: string; subject: string; paths: string[] }>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <div className="space-y-1 py-1 text-[0.9em] text-fg/muted">
      {commits.map(({ commit, paths, subject }) => (
        <div key={commit}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono">{commit.slice(0, 8)}</span>
            <span className="min-w-0 truncate text-text">{subject || "No commit subject"}</span>
          </div>
          {paths.length ? <ProjectFileLinkList paths={paths} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath ?? ""} workspaceRoots={workspaceRoots} /> : null}
        </div>
      ))}
    </div>
  );
}
